#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gn.py — 得到大脑（原 Get 笔记）OpenAPI 受控客户端

设计目标：为「分类 + 删除 + 整合」这类**破坏性批量操作**提供一个
只读优先、可全量备份、可 dry-run、可审计、可限速的本地管道。

三条硬规则（代码层面强制，不靠自觉）：
  1. 默认只读。所有写操作必须显式 --apply；不带它一律只打印「将要做的事」。
  2. 删除双重闸门：--apply 之外还需 --i-understand-deletion-may-be-permanent。
     （官方 FAQ 自列 bug：「笔记删除后直接彻底删除，未进回收站」）
  3. 每次请求写审计日志 <dataDir>/logs/*.jsonl；凭据永不写入日志/输出。

零第三方依赖：仅用 Python 标准库（urllib / json / argparse ...）。
运行： <dsh-python> dsh-getbrain/gn.py <command> [options]
文档： https://doc.biji.com/docs/WOxgwObNNiyMHWk1dl0cJqSxnEd
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import sys
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "config.local.json"       # 只放 secret（gitignore，不进导出包）
CONFIG_EXAMPLE = ROOT / "config.example.json"
SETTINGS_FILE = ROOT / "settings.json"          # 非敏感偏好（可入库/可打包）
WORKSPACE = ROOT.parent

# 统一数据目录：所有下载、中间产物、快照、日志、审计、计划都归到它下面。
# 优先级：--data-dir > 环境变量 GETNOTE_DATA_DIR > settings.json.dataDir > 下面这个默认值。
# 默认值 = 「仓库同级」的 data-getbrain —— 本机即 C:\dsh\data-getbrain（插件在
# C:\dsh\dshplug\dsh-getbrain，WORKSPACE = C:\dsh\dshplug）。
#
# 为什么不在 WORKSPACE 里：WORKSPACE 就是 Git 仓库根，数据落进去会被 git status 弄脏、
# 也会被打包带走。放在仓库的**同级**目录：
#   1) 代码目录可以整体打包/发布，不会把几十 MB 笔记一起打进去；
#   2) 天然落在仓库之外 → 不进 Git 同步，用户本机自己控制；
#   3) 删了也不会丢数据（换机器/重建工作区不影响）。
# 命名约定：C:\dsh\data-<插件短名> 是本机技能的默认数据位，首次运行自动创建（幂等）。
DEFAULT_DATA_DIR = WORKSPACE.parent / "data-getbrain"
SUBDIRS = ("downloads", "intermediate", "snapshots", "logs", "state")

def resolve_data_dir(cli_override=None):
    raw = cli_override
    if not raw:
        raw = (_load_settings().get("dataDir") or "").strip()
    p = Path(raw).expanduser() if raw else DEFAULT_DATA_DIR
    if not p.is_absolute():
        p = (WORKSPACE / p)
    return p.resolve()


def _load_settings():
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8")) or {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _layout(data_dir):
    """只计算各子目录位置，不落盘。模块导入时用，避免建出幽灵目录。"""
    return {sub: data_dir / sub for sub in SUBDIRS}


def init_layout(data_dir):
    """一次性建好统一目录结构（幂等）。"""
    for sub in SUBDIRS:
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    return _layout(data_dir)


# 运行时布局：模块导入时只计算不落盘，实际建目录发生在 reconfigure() / init_layout()。
# 否则 `import gn` 这种纯读场景会在默认位置建出一个空的幽灵数据目录。
LAYOUT = _layout(DEFAULT_DATA_DIR)
SNAPSHOTS = LAYOUT["snapshots"]
AUDIT = LAYOUT["logs"]
STATE = LAYOUT["state"]
DATA_DIR = DEFAULT_DATA_DIR


def reconfigure(data_dir):
    """按最终 dataDir 重设所有输出目录（--data-dir / settings.json 生效点）。"""
    global LAYOUT, SNAPSHOTS, AUDIT, STATE, DATA_DIR
    DATA_DIR = Path(data_dir).resolve()
    LAYOUT = init_layout(DATA_DIR)
    SNAPSHOTS = LAYOUT["snapshots"]
    AUDIT = LAYOUT["logs"]
    STATE = LAYOUT["state"]

DEFAULT_BASE = "https://openapi.biji.com"
API_PREFIX = "/open/api/v1"

ENV_KEY = "GETNOTE_API_KEY"
ENV_CID = "GETNOTE_CLIENT_ID"
ENV_URL = "GETNOTE_API_URL"
ENV_DATA_DIR = "GETNOTE_DATA_DIR"
ENV_MIN_INTERVAL = "GETNOTE_MIN_INTERVAL"
ENV_MEDIA_IMAGES = "GETNOTE_MEDIA_IMAGES"
ENV_CONFIG_FILE = "GETNOTE_CONFIG_FILE"   # 插件 Config.apiKeyFile 注入的本地凭据文件

# 用户指定的 apiKeyFile 不存在时记在这里，由 doctor 显式提示（不静默忽略）。
_MISSING_KEYFILE = []

# 插件 Config.apiKeyFile 的默认值。只有当用户改成其他路径且该文件不存在时才告警，
# 否则新用户一开面板就会看到“你指定的路径不存在”的假警报。
DEFAULT_CONFIG_REL = "dsh-getbrain/config.local.json"


def _truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def effective_min_interval():
    for raw in (os.environ.get(ENV_MIN_INTERVAL), _load_settings().get("minInterval")):
        if raw not in (None, ""):
            try:
                return max(0.2, float(raw))
            except (TypeError, ValueError):
                pass
    return MIN_INTERVAL


def effective_media_images():
    if os.environ.get(ENV_MEDIA_IMAGES) is not None:
        return _truthy(os.environ.get(ENV_MEDIA_IMAGES))
    media = _load_settings().get("media")
    return _truthy(media.get("images")) if isinstance(media, dict) else False

# 下载策略：默认只取全文字，绝不下载音频/视频；图片默认关闭（可开）。
MEDIA_POLICY = {"text": True, "audio": False, "video": False, "images": False}

MIN_INTERVAL = 0.55          # ~1.8 req/s，压在官方 ~2 QPS 之下
MAX_RETRIES = 6
HTTP_TIMEOUT = 40

# 语义上是「读」的 POST：不能因为用了 POST 就被写闸门拦住
READ_POSTS = {"/resource/recall", "/resource/recall/knowledge"}

SECRET_RE = re.compile(r"(gk_live_[A-Za-z0-9_\-]+|cli_[A-Za-z0-9_\-]+)")


def setup_io():
    """Windows 默认 GBK 控制台无法编码 ⚠/✅/→ 等符号，强制 UTF-8 输出。
    配合 gn.ps1 把 PowerShell 侧解码也设为 UTF-8，中文/符号才不乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def redact(text: str) -> str:
    """任何可能进入日志/终端的文本先过一遍，避免凭据泄露。"""
    return SECRET_RE.sub(lambda m: m.group(0)[:8] + "…(redacted)", str(text))


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def jdump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


def sid(value) -> str:
    """雪花 ID 一律字符串；>2^53 的数字会被服务端拒绝。"""
    return str(value).strip()


class ApiError(Exception):
    def __init__(self, message, code=None, reason=None, status=None, payload=None):
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.status = status
        self.payload = payload


def load_credentials(require=True):
    """凭据解析（不进命令行参数、不回显）。

    优先级（高 → 低）：环境变量 > settings.json 的 apiKey/clientId
                     > settings.json.apiKeyFile 指向的本地 json
                     > dsh-getbrain/config.local.json。

    说明：Cordis 插件的 Config 里可以直接粘 apiKey/clientId，但更安全的做法是
    用 apiKeyFile 指向一个本地文件（如 config.local.json）——组合树是明文落盘的。
    插件入口会把有效配置通过环境变量注入本进程，因此这里读环境变量即可覆盖。
    """
    key = os.environ.get(ENV_KEY) or ""
    cid = os.environ.get(ENV_CID) or ""
    # 插件若已从凭据库（.credentials.yaml）取到密钥，会置 GETNOTE_CRED_SOURCE=credentials。
    # 这样自检不会把它误显示成 "env"（那看起来像明文配置）。
    _src_hint = os.environ.get("GETNOTE_CRED_SOURCE") or ""
    src = (_src_hint or "env") if (key or cid) else ""
    st = _load_settings()

    if not key and st.get("apiKey"):
        key, src = st["apiKey"], "settings.json"
    if not cid and st.get("clientId"):
        cid = st["clientId"]

    # apiKeyFile 指向一个只含 {"api_key": "...", "client_id": "..."} 的本地文件。
    # 插件会把 Config.apiKeyFile 通过 GETNOTE_CONFIG_FILE 注入；相对路径相对工作区根。
    if not key or not cid:
        ref = os.environ.get(ENV_CONFIG_FILE) or st.get("apiKeyFile") or ""
        if ref and not (os.path.isabs(ref) or str(ref).startswith("~")):
            refp = WORKSPACE / ref
        else:
            refp = Path(ref).expanduser() if ref else CONFIG_FILE
        if refp.exists():
            try:
                cfg = json.loads(refp.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                raise ApiError(f"配置文件解析失败：{refp} ({exc})") from exc
            key = key or cfg.get("api_key") or ""
            cid = cid or cfg.get("client_id") or ""
            base_from_cfg = cfg.get("api_base") or ""
            if not src:
                src = f"file:{refp.name}"
        else:
            # 只有用户真的改过 apiKeyFile（跟默认值不同）才报错。
            # 默认值 dsh-getbrain/config.local.json 永远会被注入，而新用户本来就没这个文件，
            # 不区分的话每个人一打开面板就会看到一条“你指定的路径不存在”的假警报。
            # 否则只会看到「凭据未配置」，根本不知道是路径写错了。
            if ref and str(ref).replace("\\", "/").lstrip("./") != DEFAULT_CONFIG_REL:
                _MISSING_KEYFILE.append(str(refp))
            base_from_cfg = ""
    else:
        base_from_cfg = ""

    base = (os.environ.get(ENV_URL) or st.get("apiBase")
            or base_from_cfg or DEFAULT_BASE)
    if require and (not key or not cid):
        raise ApiError(
            "缺少凭据。推荐做法：\n"
            "  A.（最安全）打开 DSH「设置 → Getnote」，在顶部两个安全输入框里填\n"
            "     API Key 和 Client ID，点「保存凭据」。会存进 DSH 凭据库，\n"
            "     不进插件配置明文。两个都要填（接口同时校这两个）。\n"
            f"  B. 不想用面板：环境变量 {ENV_KEY} / {ENV_CID}，\n"
            f"     或 settings.json 填 apiKey / clientId，\n"
            f"     或把 {CONFIG_EXAMPLE.name} 复制为 {CONFIG_FILE.name} 填 api_key / client_id\n"
            "     （这几种都是本地明文，权限靠文件 ACL）。\n"
            "  在 https://www.biji.com/openapi 创建应用获取（API Key 只显示一次）。\n"
            "  切勿把凭据贴进聊天或提交到仓库。"
        )
    return key, cid, str(base).rstrip("/"), (src or "none")


def mask(value: str) -> str:
    if not value:
        return "(missing)"
    return value[:8] + "…" + value[-4:] if len(value) > 14 else "***"


class Client:
    """单一出口：鉴权 / 限速 / 重试 / success:false 判定 / 审计 / dry-run 闸门。"""

    def __init__(self, key, cid, base, *, dry_run=True, verbose=False, audit=True,
                 min_interval=None, policy=None):
        self.key, self.cid, self.base = key, cid, base
        self.dry_run = dry_run
        self.verbose = verbose
        self.audit = audit
        self.min_interval = float(min_interval if min_interval is not None
                                 else effective_min_interval())
        # 默认策略：只取全文字；音频/视频永不下载；图片仅显式开启
        self.policy = dict(MEDIA_POLICY)
        self.policy["images"] = effective_media_images()
        st_policy = _load_settings().get("media", {})
        if isinstance(st_policy, dict):
            self.policy.update({k: bool(v) for k, v in st_policy.items() if k in self.policy})
        if os.environ.get(ENV_MEDIA_IMAGES) is not None:
            self.policy["images"] = _truthy(os.environ.get(ENV_MEDIA_IMAGES))
        self.policy["audio"] = False       # 硬约束：不下载音频
        self.policy["video"] = False       # 硬约束：不下载视频
        if policy:
            self.policy.update({k: bool(v) for k, v in policy.items() if k in self.policy})
            self.policy["audio"] = False
            self.policy["video"] = False
        self._last = 0.0
        self.calls = 0
        self.last_headers = {}   # 最近一次响应的配额/限速头
        if audit:
            AUDIT.mkdir(parents=True, exist_ok=True)
            self.audit_path = AUDIT / f"{datetime.now().strftime('%Y%m%d')}.jsonl"

    # ---------- 基础设施 ----------
    def _capture_headers(self, headers):
        """记录响应头里的配额/限速信息，供 doctor 展示（不改变调用行为）。"""
        keep = {}
        for k, v in (headers or {}).items():
            kl = k.lower()
            if any(t in kl for t in ("ratelimit", "rate-limit", "quota", "remain",
                                    "limit", "reset", "retry-after")):
                keep[k] = v
        if keep:
            self.last_headers = keep

    def _throttle(self):
        dt = time.monotonic() - self._last
        if dt < self.min_interval:
            time.sleep(self.min_interval - dt)
        self._last = time.monotonic()

    def _audit(self, record):
        if not self.audit:
            return
        try:
            with self.audit_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        except OSError as exc:
            print(redact(f"[warn] 审计日志写入失败：{exc}"), file=sys.stderr)

    @staticmethod
    def _backoff(attempt, reason):
        if reason in ("quota_day", "quota_month"):
            raise ApiError(f"配额已用尽（{reason}），停止重试，请次日/次月再试或降低批量规模。",
                           reason=reason)
        if reason == "not_member":
            raise ApiError("非会员（not_member）：官方 OpenAPI/Skill/MCP/CLI 均要求会员账号。",
                           reason=reason)
        wait = min(2 ** min(attempt, 5), 60)
        if reason in ("qps_global", "qps_bucket"):
            wait = max(wait, 3)
        return wait

    # ---------- 唯一请求出口 ----------
    def call(self, method, path, *, body=None, params=None, mutate=False, note=""):
        """
        mutate=True 表示该调用会改动线上数据；dry_run 时只返回计划、不发包。
        返回解析后的 data；失败抛 ApiError；dry-run 返回 {"__dry_run__": True, ...}。
        """
        if mutate and self.dry_run:
            planned = {"__dry_run__": True, "method": method, "path": path,
                       "params": params or {}, "body": body or {}, "note": note}
            self._audit({"ts": now_iso(), "dry_run": True, "method": method,
                         "path": path, "params": params or {},
                         "body_keys": sorted((body or {}).keys()), "note": note})
            return planned

        url = self.base + API_PREFIX + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        raw_body = None
        headers = {"Authorization": self.key, "X-Client-ID": self.cid,
                   "Accept": "application/json", "User-Agent": "gn.py/1.0 (+local-audit)"}
        if body is not None:
            raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        last_err = None
        for attempt in range(MAX_RETRIES + 1):
            self._throttle()
            req = urllib.request.Request(url, data=raw_body, method=method, headers=headers)
            started = time.time()
            status, raw = 0, ""
            try:
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    status = resp.status
                    self._capture_headers(dict(resp.headers))
                    raw = resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as exc:
                status = exc.code
                try:
                    raw = exc.read().decode("utf-8", "replace")
                except Exception:  # noqa: BLE001
                    raw = ""
            except urllib.error.URLError as exc:
                last_err = f"网络错误：{exc.reason}"
                if attempt < MAX_RETRIES:
                    wait = self._backoff(attempt, None)
                    print(redact(f"[retry {attempt + 1}/{MAX_RETRIES}] {last_err}，{wait}s 后重试"),
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise ApiError(last_err) from exc
            except (TimeoutError, socket.timeout, OSError) as exc:
                # 坑：ssl 层的「读超时」抛的是 TimeoutError，而 Python 3.10+ 里
                # TimeoutError 并不是 URLError 的子类（已实测：issubclass=False）。
                # 所以只接 URLError 的重试逻辑罩不住它——一次慢响应就直接把
                # 整个下载进程崩掉。此地专门补上，走同一套退避重试。
                kind = "读超时" if isinstance(exc, (TimeoutError, socket.timeout)) else "连接异常"
                last_err = f"网络错误（{kind}）：{exc}"
                if attempt < MAX_RETRIES:
                    wait = self._backoff(attempt, None)
                    print(redact(f"[retry {attempt + 1}/{MAX_RETRIES}] {last_err}，{wait}s 后重试"),
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise ApiError(last_err) from exc
            self.calls += 1
            try:
                payload = json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError:
                payload = {}
            err = payload.get("error") or {}
            reason = err.get("reason") if isinstance(err, dict) else None
            code = payload.get("code", err.get("code") if isinstance(err, dict) else None)
            ok = payload.get("success", True) is not False
            self._audit({
                "ts": now_iso(), "dry_run": False, "method": method, "path": path,
                "params": params or {}, "body_keys": sorted((body or {}).keys()),
                "body_sha256": hashlib.sha256(raw_body).hexdigest()[:16] if raw_body else None,
                "status": status, "success": ok, "code": code, "reason": reason,
                "duration_ms": int((time.time() - started) * 1000), "note": note,
            })

            if status == 429 or status >= 500:
                wait = self._backoff(attempt, reason)
                print(redact(f"[retry {attempt + 1}/{MAX_RETRIES}] HTTP {status} "
                             f"reason={reason} code={code}，{wait}s 后重试"), file=sys.stderr)
                time.sleep(wait)
                last_err = f"HTTP {status} reason={reason} code={code}"
                continue
            if status >= 400:
                raise ApiError(f"HTTP {status}：{redact(raw[:400])}", code=code,
                               reason=reason, status=status, payload=payload)
            if not ok:
                # 官方强调：HTTP 200 且 success:false 仍按失败处理
                raise ApiError(f"业务失败 success=false：{redact(raw[:400])}", code=code,
                               reason=reason, status=status, payload=payload)
            if self.verbose:
                print(f"[http {status}] {method} {path} -> {redact(raw[:300])}", file=sys.stderr)
            return payload.get("data", payload)

        raise ApiError(f"重试耗尽：{last_err}")

    # ---------- 只读封装 ----------
    def list_page(self, cursor=None):
        return self.call("GET", "/resource/note/list",
                         params={"cursor": cursor} if cursor else None,
                         note="list_notes")

    def detail(self, note_id):
        return self.call("GET", "/resource/note/detail",
                         params={"id": sid(note_id), "image_quality": "original"},
                         note="get_note_detail")

    def recall(self, query, top_k=5):
        return self.call("POST", "/resource/recall",
                         body={"query": query, "top_k": min(max(int(top_k), 1), 10)},
                         mutate=False, note="recall(read-only POST)")

    def topics(self):
        return self.call("GET", "/resource/knowledge/list", params={"page": 1},
                         note="list_topics")

    def subscribed_topics(self):
        return self.call("GET", "/resource/knowledge/subscribe/list", note="list_subscribe_topics")

    # ---------- 写封装（全部走 mutate=True 闸门） ----------
    def tag_add(self, note_id, tags):
        return self.call("POST", "/resource/note/tags/add",
                         body={"note_id": sid(note_id), "tags": list(tags)},
                         mutate=True, note="tags_add")

    def tag_delete(self, note_id, tag_id):
        return self.call("POST", "/resource/note/tags/delete",
                         body={"note_id": sid(note_id), "tag_id": sid(tag_id)},
                         mutate=True, note="tags_delete")

    def kb_batch_add(self, topic_id, note_ids):
        """官方限制每批最多 20 条，自动切块。"""
        out = []
        ids = [sid(x) for x in note_ids]
        for i in range(0, len(ids), 20):
            out.append(self.call("POST", "/resource/knowledge/note/batch-add",
                                 body={"topic_id": sid(topic_id), "note_ids": ids[i:i + 20]},
                                 mutate=True, note="kb_batch_add"))
        return out

    def kb_remove(self, topic_id, note_ids):
        return self.call("POST", "/resource/knowledge/note/remove",
                         body={"topic_id": sid(topic_id),
                               "note_ids": [sid(x) for x in note_ids]},
                         mutate=True, note="kb_remove")

    def kb_create(self, name, description=""):
        return self.call("POST", "/resource/knowledge/create",
                         body={"name": name, "description": description},
                         mutate=True, note="kb_create")

    def note_save(self, title, content, tags=None, topic_id=None):
        body = {"note_type": "plain_text", "title": title, "content": content}
        if tags:
            body["tags"] = list(tags)
        if topic_id:
            body["topic_id"] = sid(topic_id)
        return self.call("POST", "/resource/note/save", body=body,
                         mutate=True, note="note_save(merge)")

    def note_update(self, note_id, *, title=None, content=None, tags=None):
        body = {"note_id": sid(note_id)}
        if title is not None:
            body["title"] = title
        if content is not None:
            body["content"] = content
        if tags is not None:
            body["tags"] = list(tags)   # ⚠️ 替换覆盖，不是追加
        if len(body) == 1:
            raise ApiError("note-update 至少需要 --title / --content / --tags 之一")
        return self.call("POST", "/resource/note/update", body=body,
                         mutate=True, note="note_update")

    def note_delete(self, note_id):
        return self.call("POST", "/resource/note/delete",
                         body={"note_id": sid(note_id)},
                         mutate=True, note="note_delete(HIGH RISK)")


def make_client(args, *, dry_run=None):
    # dry-run 只预览计划、不发包，不该因为没有凭据就拒绝预览——
    # 用户看清计划内容正是「确认前」的关键一步。所以这里放宽为 require=False。
    key, cid, base, _src = load_credentials(require=not dry_run)
    return Client(key, cid, base,
                  dry_run=(dry_run if dry_run is not None else not getattr(args, "apply", False)),
                  verbose=getattr(args, "verbose", False),
                  policy=getattr(args, "policy", None))


def print_dry(res, label):
    items = res if isinstance(res, list) else [res]
    found = False
    for item in items:
        if isinstance(item, dict) and item.get("__dry_run__"):
            found = True
            print(f"  [DRY-RUN] {label}: {item['method']} {item['path']} "
                  f"body={jdump(item['body'])}")
    return found


def banner_dry(client):
    if client.dry_run:
        print("=" * 72)
        print("DRY-RUN 模式（默认）：以下操作 *不会* 改动线上任何数据。")
        print("确认无误后，对写命令追加 --apply 才会真正执行。")
        print("=" * 72)


def read_content(args):
    if getattr(args, "content_file", None):
        return Path(args.content_file).read_text(encoding="utf-8")
    if getattr(args, "content", None) is not None:
        return args.content
    if getattr(args, "stdin", False):
        return sys.stdin.read()
    return ""


# ============================ 命令实现 ============================

def cmd_doctor(args):
    # 全新解压的移植包没有这几个空目录；自检时顺手建好，保证开箱即用。
    for d in (SNAPSHOTS, AUDIT, STATE):
        d.mkdir(parents=True, exist_ok=True)
    key, cid, base, src = load_credentials(require=False)
    print("gn.py doctor — 本地自检")
    print(f"  Python        : {sys.version.split()[0]}")
    print(f"  API base      : {base}")
    print(f"  凭据来源      : {src}")
    print(f"  API Key       : {mask(key)}")
    print(f"  Client ID     : {mask(cid)}")
    print(f"  配置文件      : {CONFIG_FILE} ({'存在' if CONFIG_FILE.exists() else '未创建'})")
    print(f"  设置文件      : {SETTINGS_FILE} ({'存在' if SETTINGS_FILE.exists() else '未创建，用默认'})")
    print(f"  统一数据目录  : {DATA_DIR}")
    for name, d in LAYOUT.items():
        print(f"    {name:12s}: {d}")
    st = _load_settings()
    media = dict(MEDIA_POLICY)
    if isinstance(st.get("media"), dict):
        media.update({k: bool(v) for k, v in st["media"].items() if k in media})
    media["audio"] = media["video"] = False
    print(f"  下载策略      : 文字=始终 图片={media['images']} 音频/视频=永不")
    print(f"  限速          : {st.get('minInterval', MIN_INTERVAL)}s/请求")
    if not key or not cid:
        if _MISSING_KEYFILE:
            for p in _MISSING_KEYFILE:
                print(f"\n  ⚠ 你指定的 apiKeyFile 不存在：{p}")
            print("    请到设置面板检查「本地凭据文件」这个路径，或改用面板顶部的安全输入框。")
        # 精确指出缺哪个，别笼统说“未配置”——用户明明填了一个会被搞糊涂。
        if key and not cid:
            print("\n  ⚠ 有 API Key，但缺 Client ID。两个都要填（接口会同时校）。")
        elif cid and not key:
            print("\n  ⚠ 有 Client ID，但缺 API Key。两个都要填（接口会同时校）。")
        else:
            print("\n  ⚠ 凭据未配置（API Key 与 Client ID 都缺）。")
        print("     填法：设置面板顶部的两个安全输入框，或 apiKeyFile / config.local.json。")
        print("     填完加 --live 再跑一次。")
        return 0
    if not args.live:
        print("\n  凭据已就绪。加 --live 做一次只读连通性测试（会消耗 1 次读配额）。")
        return 0
    c = Client(key, cid, base, dry_run=False)
    try:
        data = c.list_page()
        notes = (data or {}).get("notes", []) if isinstance(data, dict) else []
        print(f"\n  ✅ 连通成功：首页返回 {len(notes)} 条笔记，has_more={(data or {}).get('has_more')}")
        print(f"  会员状态      : ✅ 有效（能正常读列表，说明是会员账号）")
        # 配额：官方有专门的只读接口 /resource/rate-limit/quota，优先主动查精确额度；
        # 响应头里通常没有 RateLimit 字段，所以不能只靠头。
        _q = None
        try:
            _q = c.call("GET", "/resource/rate-limit/quota", note="doctor quota")
        except Exception:
            _q = None
        if isinstance(_q, dict) and _q:
            for _scope in ("read", "write", "write_note", "ai_chat"):
                _blk = _q.get(_scope)
                if not isinstance(_blk, dict):
                    continue
                _d = _blk.get("daily") or {}
                _m = _blk.get("monthly") or {}
                if _d:
                    print(f"  配额/{_scope:<10}: 今日 {_d.get('used')}/{_d.get('limit')}"
                          f"（剩 {_d.get('remaining')}）｜本月 {_m.get('used')}/{_m.get('limit')}"
                          f"（剩 {_m.get('remaining')}）")
            _pol = (_q.get("rate_limit_policy") or {})
            _rates = _pol.get("rates") or {}
            if _rates:
                _parts = []
                for _k in ("global", "read", "write", "write_note"):
                    _r = _rates.get(_k)
                    if isinstance(_r, dict):
                        _parts.append(f"{_k}={_r.get('sustained_rate_per_second')}/s")
                if _parts:
                    print("  限速策略      : " + " ".join(_parts))
        else:
            # 旧版本/不同部署没有这个接口时，退回看响应头，再退到实话说没有
            hdrs = getattr(c, "last_headers", {}) or {}
            if hdrs:
                for k in sorted(hdrs):
                    print(f"  配额/{k}: {hdrs[k]}")
            else:
                print("  配额          : 配额接口不可用，响应头也未下发（只能靠 429 判断）")
        print(f"  audit: {c.audit_path}")
        return 0
    except ApiError as exc:
        # 先给一句人话结论，别让用户自己去啃那串原始 JSON。
        _code = getattr(exc, "code", None)
        _reason = getattr(exc, "reason", None) or ""
        _status = getattr(exc, "status", None)
        if _reason == "unauthorized" or str(_code) in ("10001", "10004") or _status == 401:
            print("\n  ❌ 连不上：官方拒绝了这对凭据（HTTP 401）。")
            print("     通常是：API Key 或 Client ID 没填/抄错/抄不完整，或两者不是同一个应用下的。")
            print("     去 https://www.biji.com/openapi 重新看一眼（Key 只显示一次，错了只能重建）。")
        elif _reason == "not_member" or str(_code) == "10201":
            print("\n  ❌ 连不上：能认证，但这个账号不是会员（not_member）。")
        elif _status == 429:
            print("\n  ❌ 连不上：被限流（HTTP 429），稍后重试或降低批量。")
        else:
            print("\n  ❌ 连通失败。")
        # 原始报文保留在下面，方便贴给客服/排查，但不再是主角。
        print(f"     原始报文：{redact(str(exc))}")
        # 会员状态单独一行：面板会正则抽这一行，所以措辞不能变。
        # （修掉 401/10004 时重复输出两遍的毛病）
        reason = getattr(exc, "reason", None) or ""
        code = getattr(exc, "code", None)
        if reason == "not_member" or str(code) == "10201":
            print("  会员状态      : ❌ 无效（not_member）—— 去 biji.com 开通会员后再试")
        elif reason == "unauthorized" or str(code) in ("10001", "10004"):
            # 10004 / reason=unauthorized 是实测：不带凭据或凭据不对时官方返回（HTTP 401）。
            print("  会员状态      : ⚠ 无法判定（凭据未通过认证，原因见上）")
        elif getattr(exc, "status", None) == 429:
            print("  会员状态      : ⚠ 无法判定（配额/QPS 限流，稍后重试）")
        else:
            print("  会员状态      : ⚠ 无法判定（见上方错误）")
        return 2


def cmd_backup(args):
    """Phase 0：全量只读快照。永远安全，不需要 --apply。"""
    c = make_client(args, dry_run=False)   # 只读命令，强制真实读取
    out = SNAPSHOTS / stamp()
    out.mkdir(parents=True, exist_ok=True)
    print(f"[Phase 0] 只读全量备份 -> {out}")
    notes, cursor, pages = [], None, 0
    while True:
        data = c.list_page(cursor)
        if not isinstance(data, dict):
            raise ApiError(f"note/list 返回结构异常：{redact(str(data)[:300])}")
        batch = data.get("notes", []) or []
        notes.extend(batch)
        pages += 1
        print(f"  page {pages}: +{len(batch)} 条（累计 {len(notes)}）")
        if args.max and len(notes) >= args.max:
            notes = notes[:args.max]
            print(f"  --max {args.max} 已到，停止翻页")
            break
        if not data.get("has_more"):
            break
        cursor = data.get("cursor")
        if not cursor:
            print("  [warn] has_more=true 但无 cursor，提前停止")
            break
    (out / "notes_list.json").write_text(jdump(notes), encoding="utf-8")

    details = {}
    if not args.skip_detail:
        print(f"  逐条拉取详情（{len(notes)} 条，约 {len(notes) * MIN_INTERVAL:.0f}s）…")
        for i, n in enumerate(notes, 1):
            nid = sid(n.get("note_id"))
            try:
                d = c.detail(nid)
                details[nid] = d.get("note") if isinstance(d, dict) and "note" in d else d
            except ApiError as exc:
                details[nid] = {"__error__": redact(str(exc))}
                print(f"    [warn] {nid} 详情失败：{redact(str(exc))}", file=sys.stderr)
            if i % 20 == 0:
                print(f"    {i}/{len(notes)}")
        (out / "notes_detail.json").write_text(jdump(details), encoding="utf-8")

    lines = ["# 得到大脑 笔记快照", "", f"- 生成时间：{now_iso()}",
             f"- 笔记数：{len(notes)}", f"- 详情数：{len(details)}",
             f"- API base：{c.base}", f"- 接口调用数：{c.calls}", ""]
    for n in notes:
        lines.append(f"## {n.get('title') or '(无标题)'}  `{sid(n.get('note_id'))}`")
        lines.append(f"- 类型：{n.get('note_type')} 标签：{n.get('tags')} "
                     f"知识库：{n.get('topics')}")
        lines.append(f"- 创建：{n.get('created_at')} 更新：{n.get('updated_at')}")
        txt = (n.get("content") or "").strip()
        if txt:
            lines.append("")
            lines.append(txt[:1500])
        lines.append("")
    (out / "notes.md").write_text("\n".join(lines), encoding="utf-8")

    manifest = {"generated_at": now_iso(), "api_base": c.base,
                "note_count": len(notes), "detail_count": len(details),
                "pages": pages, "calls": c.calls, "notes_md_sha256":
                hashlib.sha256((out / "notes.md").read_bytes()).hexdigest()}
    (out / "manifest.json").write_text(jdump(manifest), encoding="utf-8")
    print(f"\n✅ 备份完成：{len(notes)} 条笔记 / {len(details)} 条详情 / {c.calls} 次调用")
    print(f"   {out}")
    print("   这是删改前的兜底快照，请保留到整个整理流程验收之后再清理。")
    return 0


def _note_text(note):
    """从详情里抽出『全文字』：原文 + AI 总结，但绝不取二进制媒体。

    API 详情字段（data.note）：content / web_page.content / audio.original /
    attachments[]。CLI 文档另称 web_content / audio_original，这里兼容两种键名。

    ★ ref 类型笔记（2026-11-10 实修）：note_type='ref' 的笔记（得到课程摘录、
      网页剪藏等）正文放在 **ref_content** 里，content 是空的。
      旧版没读这个字段，导致这类笔记被写成空文件。
      结构（实测 note_id=1926209298363413304）：
          note_type: "ref"
          ref_content: "而我意识到这一招对得到好像没啥用……"   <- 正文在这
          reference: {source:"dedao", title:"万维钢·精英日课6", url:"…",
                      article:{title:"问答：怎样利用AI…", url:"…"}}
          content: ""                                          <- 空
    """
    if not isinstance(note, dict):
        return {"original": "", "summary": "", "url": "", "images": [], "reference": {}}
    n = note.get("note", note) if "note" in note else note
    wp = n.get("web_page") or {}
    au = n.get("audio") or {}
    ref = n.get("reference") if isinstance(n.get("reference"), dict) else {}

    # 正文优先级：音频转写 > 网页正文 > ref 摘录正文 > content 兜底
    original = (n.get("audio_original") or au.get("original")
                or n.get("web_content") or wp.get("content")
                or n.get("ref_content") or "")
    summary = n.get("content") or ""

    # 纯文字笔记：content 本身就是原文，避免把摘要当成正文重复
    if not original and not wp and not au and not n.get("ref_content"):
        original = summary

    # 链接：ref 类型优先用 reference.article.url（更精确的文章链接）
    art = ref.get("article") if isinstance(ref.get("article"), dict) else {}
    url = (art.get("url") or wp.get("url") or ref.get("url") or n.get("url")
           or n.get("note_url") or "")

    # 来源信息：写进 Markdown，方便回溯这篇摘录是从哪来的
    ref_meta = {}
    if ref:
        ref_meta = {
            "source": ref.get("source") or n.get("source") or "",
            "resource_type": ref.get("resource_type") or "",
            "title": ref.get("title") or "",
            "article_title": art.get("title") or "",
            "url": art.get("url") or ref.get("url") or "",
        }

    images = []
    for a in (n.get("attachments") or []):
        if not isinstance(a, dict):
            continue
        atype = str(a.get("type") or a.get("kind") or "").lower()
        aurl = a.get("url") or a.get("access_url")
        if aurl and (atype in ("image", "img", "picture", "photo") or
                     re.search(r"\.(png|jpe?g|gif|webp|bmp)(\?|$)", str(aurl), re.I)):
            images.append({"url": aurl, "name": a.get("name") or ""})
    return {"original": original, "summary": summary, "url": url,
            "images": images, "reference": ref_meta}


def fetch_binary(url, dest, timeout=HTTP_TIMEOUT):
    """下载二进制附件到 dest（只用于显式允许的图片；音频/视频永不调用）。"""
    req = urllib.request.Request(url, headers={"User-Agent": "gn.py/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            fh.write(chunk)
    return dest.stat().st_size


def cmd_download(args):
    """把全文字下载到 dataDir/downloads/ 供人分析决策。

    默认：只写 Markdown 全文（原文 + AI 总结 + 元数据）；音频/视频二进制永不下载。
    图片二进制需显式 --with-images（或 settings.json media.images=true）。
    """
    with_images = bool(getattr(args, "with_images", False)) or effective_media_images()
    c = make_client(args, dry_run=False)
    c.policy["images"] = with_images
    c.policy["audio"] = False
    c.policy["video"] = False

    # 输出目录：
    #   默认 → downloads/<时间戳>/   每次一份不可变快照（便于审计“某一刻”的全量）
    #   --into X → X/               增量写入同一目录，只重写变化过的笔记
    into = str(getattr(args, "into", "") or "").strip()
    if into:
        p = Path(into).expanduser()
        # 相对路径以**数据目录**为基准，而不是插件/工作区目录。
        # 旧行为是相对 WORKSPACE（= Git 仓库根），于是 --into getbraindata/current
        # 会把增量结果写回代码目录里，既脏仓库又跟默认数据位分家。
        out = p if p.is_absolute() else (DATA_DIR / p)
    else:
        out = LAYOUT["downloads"] / stamp()
    out.mkdir(parents=True, exist_ok=True)
    imgdir = out / "images"

    # 增量判断依据：上两次写入的 manifest 里的 note_id -> updated_at
    prev_updates = {}
    if into and not bool(getattr(args, "force", False)):
        mf = out / "manifest.json"
        if mf.exists():
            try:
                old = json.loads(mf.read_text(encoding="utf-8"))
                for rec in (old.get("notes") or []):
                    if isinstance(rec, dict) and rec.get("note_id"):
                        prev_updates[str(rec["note_id"])] = str(rec.get("updated_at") or "")
            except Exception as exc:  # noqa: BLE001
                print(f"  [warn] 旧 manifest 读不了，本次全量：{exc}", file=sys.stderr)
        # ★ 续传关键（2026-11-10 实修）：
        # 上一版只依赖 manifest，但全量下载中途被超时杀掉时 manifest 根本还没写，
        # 于是下次重跑会从头再来 → 永远跑不完。
        # 现在直接扫目录：已经有 <note_id>_*.md 的笔记一律跳过（文件名前缀就是 note_id）。
        # 这样即使进程被 kill，下次 --into 同一个目录就能接着下。
        on_disk = {}
        for f in out.glob("*.md"):
            m2 = re.match(r"^(\d+)_", f.name)
            if m2:
                on_disk[m2.group(1)] = f.name
        if on_disk:
            print(f"[download] 目录里已有 {len(on_disk)} 篇，按「已有即跳过」续传")
            for nid0, fn0 in on_disk.items():
                prev_updates.setdefault(nid0, "")

    mode = "增量" if into else "快照"
    print(f"[download] 全文字下载（{mode}）-> {out}")
    print(f"[download] 媒体策略：文字=始终 / 图片={'开' if with_images else '关'} / 音频·视频=永不")
    if prev_updates:
        print(f"[download] 已有 {len(prev_updates)} 条记录，将跳过未变化的")


    notes, cursor, pages = [], None, 0
    while True:
        d = c.list_page(cursor)
        batch = (d or {}).get("notes", []) or []
        notes.extend(batch)
        pages += 1
        print(f"  列表 page {pages}: +{len(batch)}（累计 {len(notes)}）")
        if args.max and len(notes) >= args.max:
            notes = notes[:args.max]
            break
        if not (d or {}).get("has_more") or not (d or {}).get("cursor"):
            break
        cursor = d["cursor"]

    ok, failed, images, skipped = 0, 0, 0, 0
    written = []
    for i, item in enumerate(notes, 1):
        nid = sid(item.get("note_id"))
        # 增量：updated_at 没变且文件已在 → 跳过，省一次详情请求（也省配额）
        cur_upd = str(item.get("updated_at") or "")
        # 增量/续传：有记录且 updated_at 没变 → 跳过；updated_at 未知（续传场景）也跳过
        if prev_updates and nid in prev_updates:
            known = prev_updates[nid]
            if not known or known == cur_upd:
                exist = list(out.glob(f"{nid}_*.md"))
                if exist:
                    skipped += 1
                    written.append({"note_id": nid, "updated_at": cur_upd, "file": exist[0].name, "skipped": True})
                    continue
        try:
            d = c.detail(nid)
        except ApiError as exc:
            failed += 1
            print(f"    [warn] {nid} 详情失败：{redact(str(exc))}", file=sys.stderr)
            continue
        t = _note_text(d)
        # 标题优先级：列表里的 title > 详情的 title > display_title > reference 里的标题
        # （实测：ref 类型笔记的 title 常常是空字符串，真正的题目在 display_title，
        #   例如“万维钢·精英日课6·问答：怎样利用AI带来的先发优势？”。
        #   不选它会全部叫“无标题”，文件名和索引都失去意义。）
        def _pick_title(src):
            if not isinstance(src, dict):
                return ""
            direct = src.get("title") or ""
            if direct:
                return str(direct).strip()
            ref = src.get("reference") if isinstance(src.get("reference"), dict) else {}
            art = ref.get("article") if isinstance(ref.get("article"), dict) else {}
            # 注意：display_title 常常是「课程名·问答：题目｜正文开头…」这种长串，
            # 直接当文件名又长又乱。优先用 reference.article.title（真正的文章题目）。
            short = str(art.get("title") or ref.get("title") or "").strip()
            if short:
                return short
            return str(src.get("display_title") or "").strip()
        title = (_pick_title(d) or _pick_title(item) or "无标题")
        safe = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", str(title))[:60] or "note"
        md = [
            f"# {title}", "",
            f"- note_id: `{nid}`",
            f"- 类型: {item.get('note_type') or d.get('note_type')}",
            f"- 标签: {item.get('tags') or d.get('tags')}",
            f"- 知识库: {item.get('topics') or d.get('topics')}",
            f"- 创建: {item.get('created_at')}  更新: {item.get('updated_at')}",
        ]
        if t["url"]:
            md.append(f"- 原始链接: {t['url']}")
        # ref 类型的来源（得到课程 / 网页剪藏）——方便回溯这篇摘录从哪来
        rmeta = t.get("reference") or {}
        if rmeta.get("title"):
            md.append(f"- 来源: {rmeta['title']}")
        if rmeta.get("article_title") and rmeta.get("article_title") != title:
            md.append(f"- 原文标题: {rmeta['article_title']}")
        if rmeta.get("resource_type"):
            md.append(f"- 资源类型: {rmeta['resource_type']}")
        md += ["", "## 原文（全文字）", "", t["original"] or "(无原文)", "",
               "## AI 总结", "", t["summary"] or "(无 AI 总结)", ""]
        if t["images"]:
            md.append(f"## 图片附件（{len(t['images'])} 个）")
            for k, im in enumerate(t["images"], 1):
                md.append(f"- 图片 {k}: {im['url']}")
            md.append("")
        fname = f"{nid}_{safe}.md"
        (out / fname).write_text("\n".join(md), encoding="utf-8")
        ok += 1
        written.append({"note_id": nid, "updated_at": cur_upd, "file": fname, "skipped": False})

        # 图片二进制：必须显式开启；文件名用 note_id + 序号，避免路径穿越
        if with_images and t["images"]:
            imgdir.mkdir(parents=True, exist_ok=True)
            for k, im in enumerate(t["images"], 1):
                ext = ".png"
                m = re.search(r"\.(png|jpe?g|gif|webp|bmp)", str(im["url"]), re.I)
                if m:
                    ext = "." + m.group(1).lower()
                dest = imgdir / f"{nid}_{k}{ext}"
                try:
                    fetch_binary(im["url"], dest)
                    images += 1
                except Exception as exc:  # noqa: BLE001
                    print(f"    [warn] 图片下载失败 {nid}_{k}：{redact(str(exc))}", file=sys.stderr)

        if i % 20 == 0:
            print(f"    {i}/{len(notes)}（成功 {ok}）")

    manifest = {
        "generated_at": now_iso(), "data_dir": str(DATA_DIR), "out": str(out),
        "mode": "incremental" if into else "snapshot",
        "note_count": len(notes), "text_written": ok, "skipped": skipped,
        "failed": failed, "images_downloaded": images,
        "media": dict(c.policy), "calls": c.calls,
        # notes 索引：下次 --into 靠 updated_at 判断要不要重写
        "notes": written,
    }
    (out / "manifest.json").write_text(jdump(manifest), encoding="utf-8")
    # 中间产物索引也放 dataDir/intermediate，方便后续分析
    (LAYOUT["intermediate"] / "latest_download.json").write_text(jdump(manifest), encoding="utf-8")
    parts = [f"全文 {ok} 篇"]
    if skipped:
        parts.append(f"跳过 {skipped} 篇（未变化）")
    parts += [f"失败 {failed}", f"图片 {images}", f"调用 {c.calls} 次"]
    print(f"\n✅ 下载完成：" + " / ".join(parts))
    print(f"   {out}")
    if not into:
        print(f"   提示：想增量刷新同一个目录而不是每次新建快照，用 --into current（相对数据目录 {DATA_DIR}）")
    print("   文字已落地，供人先分析决策；之后再用 plan.json + apply 改线上。")
    return 0


def cmd_list(args):
    c = make_client(args, dry_run=False)
    notes, cursor = [], None
    while True:
        d = c.list_page(cursor)
        notes.extend((d or {}).get("notes", []) or [])
        if not args.all or not (d or {}).get("has_more") or not (d or {}).get("cursor"):
            break
        cursor = d["cursor"]
    notes = notes[:args.limit] if args.limit else notes
    print(jdump(notes) if args.json else "\n".join(
        f"{sid(n.get('note_id'))}\t{n.get('note_type')}\t{n.get('title')}" for n in notes))
    print(f"\n共 {len(notes)} 条（has_more 可能还有更多）", file=sys.stderr)
    return 0


def cmd_detail(args):
    c = make_client(args, dry_run=False)
    print(jdump(c.detail(args.note_id)))
    return 0


def cmd_search(args):
    c = make_client(args, dry_run=False)
    print(jdump(c.recall(args.query, args.top_k)))
    print("⚠️ recall 是语义 Top-K（默认3/最大10），空结果不证明没有重复笔记；判重请用全量快照。",
          file=sys.stderr)
    return 0


def cmd_topics(args):
    c = make_client(args, dry_run=False)
    own = c.topics()
    print("== 我的知识库 ==")
    print(jdump(own))
    if args.include_subscribed:
        print("== 订阅知识库（只读，不可写入）==")
        print(jdump(c.subscribed_topics()))
    return 0


def _mutate_guard(args, c, extra_warning=None):
    banner_dry(c)
    if extra_warning:
        print(extra_warning)


def cmd_tag_add(args):
    c = make_client(args)
    _mutate_guard(args, c)
    r = c.tag_add(args.note_id, args.tags)
    if not print_dry(r, "tags/add"):
        print(jdump(r))
    return 0


def cmd_tag_remove(args):
    c = make_client(args)
    _mutate_guard(args, c)
    r = c.tag_delete(args.note_id, args.tag_id)
    if not print_dry(r, "tags/delete"):
        print(jdump(r))
    return 0


def cmd_kb_add(args):
    c = make_client(args)
    _mutate_guard(args, c, "官方限制：每批最多 20 条，脚本已自动切块；订阅知识库不可写。")
    rs = c.kb_batch_add(args.topic_id, args.note_ids)
    for r in rs:
        if not print_dry(r, "knowledge/note/batch-add"):
            print(jdump(r))
    return 0


def cmd_kb_remove(args):
    c = make_client(args)
    _mutate_guard(args, c)
    r = c.kb_remove(args.topic_id, args.note_ids)
    if not print_dry(r, "knowledge/note/remove"):
        print(jdump(r))
    return 0


def cmd_kb_create(args):
    c = make_client(args)
    _mutate_guard(args, c, "官方限制：每天最多创建 50 个知识库（北京时间 00:00 重置）。")
    r = c.kb_create(args.name, args.description or "")
    if not print_dry(r, "knowledge/create"):
        print(jdump(r))
    return 0


def cmd_note_save(args):
    c = make_client(args)
    content = read_content(args)
    _mutate_guard(args, c, "整合策略：新建合并笔记并保留原始笔记，不覆盖、不删原文。")
    r = c.note_save(args.title, content, args.tags, args.topic_id)
    if not print_dry(r, "note/save"):
        print(jdump(r))
    return 0


def cmd_note_update(args):
    c = make_client(args)
    warn = ("⚠️ note/update 的 --tags 是【替换覆盖】原有标签，不是追加！"
            "分类请优先用 tag-add。此处不会自动补回旧标签。")
    _mutate_guard(args, c, warn)
    r = c.note_update(args.note_id, title=args.title, content=args.content, tags=args.tags)
    if not print_dry(r, "note/update"):
        print(jdump(r))
    return 0


def cmd_note_delete(args):
    c = make_client(args)
    if not args.i_understand_deletion_may_be_permanent:
        print("❌ 拒绝执行删除。", file=sys.stderr)
        print("   官方 FAQ 自列 bug：「笔记删除后直接彻底删除，未进回收站」「存在严重误删风险」。",
              file=sys.stderr)
        print("   因此本客户端要求双重闸门：--apply 且 "
              "--i-understand-deletion-may-be-permanent", file=sys.stderr)
        print("   建议先做 Phase 0 全量备份，并把删除降级为「打归档标签 + 移入待清理知识库」。",
              file=sys.stderr)
        return 3
    _mutate_guard(args, c, "🔴 高危：note/delete 按不可逆对待。请确认 Phase 0 快照已生成并校验。")
    r = c.note_delete(args.note_id)
    if not print_dry(r, "note/delete"):
        print(jdump(r))
        print("   请立刻到 App 回收站核验该笔记是否可恢复。")
    return 0


ALLOWED_OPS = {
    "tag_add": lambda c, a: c.tag_add(a["note_id"], a["tags"]),
    "tag_delete": lambda c, a: c.tag_delete(a["note_id"], a["tag_id"]),
    "kb_batch_add": lambda c, a: c.kb_batch_add(a["topic_id"], a["note_ids"]),
    "kb_remove": lambda c, a: c.kb_remove(a["topic_id"], a["note_ids"]),
    "kb_create": lambda c, a: c.kb_create(a["name"], a.get("description", "")),
    "note_save": lambda c, a: c.note_save(a["title"], a["content"],
                                          a.get("tags"), a.get("topic_id")),
    "note_update": lambda c, a: c.note_update(a["note_id"], title=a.get("title"),
                                              content=a.get("content"), tags=a.get("tags")),
    "note_delete": lambda c, a: c.note_delete(a["note_id"]),
}
HIGH_RISK_OPS = {"note_delete", "note_update"}


def cmd_apply(args):
    """执行经过人工确认的 JSON 计划（Phase 2/3）。串行、限速、出错即停。"""
    plan_path = Path(args.plan)
    if not plan_path.exists():
        raise ApiError(f"计划文件不存在：{plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("version") != 1:
        raise ApiError("计划文件 version 必须为 1")
    actions = plan.get("actions", [])
    if not isinstance(actions, list) or not actions:
        raise ApiError("计划文件 actions 为空或格式错误")
    for i, a in enumerate(actions):
        if a.get("op") not in ALLOWED_OPS:
            raise ApiError(f"actions[{i}] 的 op 非法：{a.get('op')}；允许 {sorted(ALLOWED_OPS)}")
    risky = [a["op"] for a in actions if a["op"] in HIGH_RISK_OPS]
    if risky and not args.allow_high_risk:
        raise ApiError(f"计划含高危操作 {sorted(set(risky))}，需额外 --allow-high-risk")
    if args.confirm != "CONFIRM":
        raise ApiError("需显式 --confirm CONFIRM 才会真正执行（防止误跑）")

    if args.only_op:
        actions = [a for a in actions if a["op"] in args.only_op]
    if args.limit:
        actions = actions[:args.limit]

    print(f"[apply] 计划 {plan_path.name}：生成于 {plan.get('generated_at')}，"
          f"待执行 {len(actions)} 个动作")
    if args.dry_run:
        print("[apply] --dry-run：仅预览，不发包。")
    c = make_client(args, dry_run=args.dry_run)
    results = []
    for i, a in enumerate(actions, 1):
        op = a["op"]
        print(f"  [{i}/{len(actions)}] {op}  {a.get('reason', '')}")
        try:
            r = ALLOWED_OPS[op](c, a.get("args", {}))
            if isinstance(r, list):
                results.extend([{"op": op, "result": x} for x in r])
            else:
                results.append({"op": op, "result": r})
            if not print_dry(r, op):
                print(f"      -> ok")
        except ApiError as exc:
            print(f"      -> ❌ {redact(str(exc))}", file=sys.stderr)
            results.append({"op": op, "error": redact(str(exc))})
            if not args.continue_on_error:
                print("  出错即停（--continue-on-error 可改为继续）。", file=sys.stderr)
                break
        except (KeyError, TypeError) as exc:
            # plan 里的 args 缺字段/类型不对时，别把 Python 栈直接撑给用户看。
            # 这里把它变成能看懂的提示，并保留出错即停的默认行为。
            miss = exc.args[0] if exc.args else exc
            msg = f"动作 {op} 的参数不完整或类型不对（缺/错：{miss!r}）；请检查 plan 里的 args"
            print(f"      -> ❌ {msg}", file=sys.stderr)
            results.append({"op": op, "error": msg})
            if not args.continue_on_error:
                print("  出错即停（--continue-on-error 可改为继续）。", file=sys.stderr)
                break
    STATE.mkdir(parents=True, exist_ok=True)
    log = STATE / f"apply-{stamp()}.json"
    log.write_text(jdump({"plan": str(plan_path), "executed_at": now_iso(),
                          "dry_run": args.dry_run, "calls": c.calls, "results": results}),
                   encoding="utf-8")
    print(f"\n[apply] 完成，调用 {c.calls} 次；结果日志 {log}")
    return 0


def cmd_plan_template(args):
    print(jdump({
        "version": 1,
        "generated_at": "填写生成时间（人工确认后填写，不要伪造）",
        "confirmed_by": "USER_CONFIRMED",
        "source_snapshot": "snapshots/<时间戳>/manifest.json",
        "actions": [
            {"op": "tag_add", "reason": "示例：归入工作类",
             "args": {"note_id": "1907975006118548200", "tags": ["工作", "重要"]}},
            {"op": "kb_batch_add", "reason": "示例：加入知识库（自动按 20 条切块）",
             "args": {"topic_id": "abc123", "note_ids": ["1907975006118548200"]}},
            {"op": "note_save", "reason": "示例：新建合并笔记，保留原文",
             "args": {"title": "合并：XX 主题", "content": "……", "tags": ["整合"]}},
        ],
        "_notes": [
            "op 白名单：tag_add / tag_delete / kb_batch_add / kb_remove / kb_create / note_save / note_update / note_delete",
            "note_update 与 note_delete 为高危，apply 时需 --allow-high-risk",
            "所有 ID 用字符串；删除前务必先跑 backup 并校验快照",
        ],
    }))
    return 0


# ============================ 导出 / 移植 ============================

# 可移植包里应包含的文件（相对 ROOT）。凭据 config.local.json 与所有运行产物都不在内。
# dsh-getbrain/ 目录本身就是一个 Cordis Bundle：代码 + 插件入口 + SKILL.md 说明一体。
PORTABLE_FILES = [
    "gn.py", "gn.ps1", "config.example.json", "settings.example.json",
    "README.md", "SKILL.md",
    "package.json", "cordis.patch.yml", "index.js", "client.js", "icon.svg",
    "locale/en.json", "locale/zh.json",
]

# 导出包自带的忽略规则。原先复用仓库里的 dsh-getbrain/.gitignore，
# 但 ADR-007 把子目录 .gitignore 统一上提到仓库根后，导出包里就没有这份文件了；
# 因此改为在打包时动态写入，保证「解压出来的 dsh-getbrain/ 目录」依然自带凭据保护。
PORTABLE_GITIGNORE = """\
config.local.json
settings.json
*.credentials*
getbraindata/
data-getbrain/
data-*/
current/
data/
snapshots/
audit/
state/
downloads/
intermediate/
logs/
*.jsonl
*.log
__pycache__/
*.pyc
.venv/
venv/
dist/
*.zip
*.tgz
"""

INSTALL_HINT = """\
安装到别的 DSH / 工作区 / 机器（两种用法，同一份文件）：

【A. 作为正式 Cordis 插件（推荐，可在 DSH 配置里填 Key / dataDir）】
  1) 把 zip 解压到目标工作区，得到 dsh-getbrain/ 目录（它本身就是一个 bundle）。
  2) 在目标 DSH 会话里执行：plugin_manager  action: install_bundle
     target: <dsh-getbrain 目录的绝对路径>
  3) 在「设置 → Getnote」侧边栏或插件行 config 填 apiKey / clientId（或用 apiKeyFile 指向本地 json 更安全）、
     dataDir（统一数据目录，默认 = 本仓库同级的 data-getbrain，自动创建；可改绝对路径）、media.images（默认 false）。
  4) 安装后任何会话都有 getnote_doctor / getnote_download 等工具，且 agent 会自动加载 SKILL.md 的整理纪律。
  5) 面板里改配置即时生效（volatile 字段就地写回），无需重启；仅改 index.js / dsh.client 才需重启。

【B. 只用 CLI，不装插件】
  1) 复制 dsh-getbrain/config.example.json 为 dsh-getbrain/config.local.json，填入 api_key / client_id；
     复制 settings.example.json 为 settings.json，按需改 dataDir / media.images / minInterval。
     不填 dataDir 就用默认值（本仓库同级的 data-getbrain，自动创建）。
     —— 或设环境变量 GETNOTE_API_KEY / GETNOTE_CLIENT_ID / GETNOTE_DATA_DIR。
  2) 目标机需 Python 3.9+（gn.ps1 按 GETNOTE_PYTHON > PATH python/py > $DSH_HOME 自带 Python 查找）。
     非 Windows 直接：python3 dsh-getbrain/gn.py doctor --live
  3) 自检： .\\dsh-getbrain\\gn.ps1 doctor     下载全文： .\\dsh-getbrain\\gn.ps1 download
  4) 写操作仍需 --apply；删除需双重闸门。完整说明见 dsh-getbrain/README.md。

统一数据目录 dataDir（默认 = 本仓库同级的 data-getbrain，首次运行自动创建、不进 Git）下：
downloads/（全文字）intermediate/（中间产物）snapshots/（快照）logs/（审计）state/（计划与执行结果）。
默认只下载全文字，音频/视频二进制永不下载，图片需显式开启。
Key/ID 输入：首选「设置 → Getnote」侧边栏；详见 dsh-getbrain/README.md。
零第三方依赖、换用户名 / 换安装路径都能跑。
"""


def cmd_export(args):
    """把整个工具包打成可移植 zip。默认绝不包含任何凭据。"""
    out = Path(args.out) if getattr(args, "out", None) else Path(f"getnote-toolkit-{stamp()}.zip")
    if not out.is_absolute():
        out = (Path.cwd() / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    files = [f for f in PORTABLE_FILES if (ROOT / f).exists()]
    include_key = getattr(args, "include_key", False)
    key_included = False
    if include_key and CONFIG_FILE.exists():
        files.append(CONFIG_FILE.name)
        key_included = True

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in files:
            z.write(ROOT / name, arcname=f"dsh-getbrain/{name}")
        z.writestr("dsh-getbrain/.gitignore", PORTABLE_GITIGNORE)
        z.writestr("dsh-getbrain/INSTALL.txt", INSTALL_HINT)

    print(f"[export] 已生成可移植工具包：{out}")
    print(f"[export] 包含 {len(files)} 个文件：{', '.join(files)}")
    if key_included:
        print("  🔴 警告：本次用 --include-key 把 config.local.json（含真实 Key）打进了 zip！", file=sys.stderr)
        print("     这个 zip 现在等同明文凭据，切勿放进聊天/网盘/公开仓库，用完立即删除或去开放平台作废该 Key。", file=sys.stderr)
    else:
        print("[export] 未包含任何凭据（默认安全）。目标机需另填 config.local.json 或设环境变量。")
    print("\n" + INSTALL_HINT)
    return 0


# ============================ CLI ============================

def build_parser():
    p = argparse.ArgumentParser(
        prog="gn.py", description="得到大脑 OpenAPI 受控客户端（默认只读、写操作需 --apply）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""常用流程：
  1) doctor --live                       验证会员/Key/网络
  2) backup                              Phase 0 全量只读快照（必须先做）
  3) （我基于快照出 dry-run 整理方案，给你过目）
  4) apply --plan plan.json --confirm CONFIRM
  5) App 回收站核验删除结果

安全：所有写命令不带 --apply 时只打印计划；删除另需
      --i-understand-deletion-may-be-permanent。
""")
    p.add_argument("-v", "--verbose", action="store_true", help="打印每次 HTTP 响应片段")
    p.add_argument("--data-dir", dest="data_dir", default=None,
                   help="统一数据目录（下载/中间产物/快照/日志/审计/计划都归它；优先级高于 settings.json.dataDir）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_write(sp):
        sp.add_argument("--apply", action="store_true",
                        help="真正执行写操作；不加则 dry-run 只打印计划")

    d = sub.add_parser("doctor", help="本地自检 / 只读连通性测试")
    d.add_argument("--live", action="store_true", help="发一次只读 note/list 验证凭据")
    d.set_defaults(func=cmd_doctor)

    b = sub.add_parser("backup", help="Phase 0：全量只读快照（永远安全）")
    b.add_argument("--max", type=int, default=0, help="最多拉多少条（0=全部，调试用）")
    b.add_argument("--skip-detail", action="store_true", help="只拉列表不逐条拉详情（快）")
    b.set_defaults(func=cmd_backup)

    dl = sub.add_parser("download", help="下载全文字到 dataDir/downloads（默认不下载音频/视频，图片需 --with-images）")
    dl.add_argument("--max", type=int, default=0, help="最多下载多少条（0=全部，调试用）")
    dl.add_argument("--with-images", action="store_true", help="额外下载图片二进制（默认只写全文文字）")
    # 增量刷新：写回同一个目录，只重写 updated_at 变了的笔记。
    # 不传 --into 时保持旧行为（每次新建时间戳目录），便于审计“某一刻的快照”。
    dl.add_argument("--into", default="",
                    help="增量模式：写入指定目录（相对路径相对**数据目录**，如 current → <dataDir>/current），已是最新的笔记不重写。留空=新建时间戳目录。")
    dl.add_argument("--force", action="store_true", help="配合 --into：忽略增量判断，全部重写")
    dl.set_defaults(func=cmd_download)

    l = sub.add_parser("list", help="只读列出笔记")
    l.add_argument("--all", action="store_true", help="自动翻完所有页")
    l.add_argument("--limit", type=int, default=20)
    l.add_argument("--json", action="store_true")
    l.set_defaults(func=cmd_list)

    de = sub.add_parser("detail", help="只读读取单条详情")
    de.add_argument("note_id")
    de.set_defaults(func=cmd_detail)

    s = sub.add_parser("search", help="只读语义搜索（Top-K，非全量）")
    s.add_argument("query")
    s.add_argument("--top-k", type=int, default=5)
    s.set_defaults(func=cmd_search)

    t = sub.add_parser("topics", help="只读列出知识库")
    t.add_argument("--include-subscribed", action="store_true")
    t.set_defaults(func=cmd_topics)

    ta = sub.add_parser("tag-add", help="追加标签（分类首选，不会覆盖旧标签）")
    ta.add_argument("--note-id", required=True)
    ta.add_argument("--tags", nargs="+", required=True)
    add_write(ta)
    ta.set_defaults(func=cmd_tag_add)

    tr = sub.add_parser("tag-remove", help="删除某个标签（system 类型标签不可删）")
    tr.add_argument("--note-id", required=True)
    tr.add_argument("--tag-id", required=True)
    add_write(tr)
    tr.set_defaults(func=cmd_tag_remove)

    ka = sub.add_parser("kb-add", help="批量加入知识库（自动按 20 条切块）")
    ka.add_argument("--topic-id", required=True)
    ka.add_argument("--note-ids", nargs="+", required=True)
    add_write(ka)
    ka.set_defaults(func=cmd_kb_add)

    kr = sub.add_parser("kb-remove", help="从知识库移除笔记")
    kr.add_argument("--topic-id", required=True)
    kr.add_argument("--note-ids", nargs="+", required=True)
    add_write(kr)
    kr.set_defaults(func=cmd_kb_remove)

    kc = sub.add_parser("kb-create", help="创建知识库（每天最多 50 个）")
    kc.add_argument("--name", required=True)
    kc.add_argument("--description", default="")
    add_write(kc)
    kc.set_defaults(func=cmd_kb_create)

    ns = sub.add_parser("note-save", help="新建合并笔记（整合时保留原文）")
    ns.add_argument("--title", required=True)
    ns.add_argument("--content")
    ns.add_argument("--content-file", help="从 UTF-8 文件读正文")
    ns.add_argument("--stdin", action="store_true", help="从标准输入读正文")
    ns.add_argument("--tags", nargs="*")
    ns.add_argument("--topic-id")
    add_write(ns)
    ns.set_defaults(func=cmd_note_save)

    nu = sub.add_parser("note-update", help="改笔记（⚠️ --tags 为替换覆盖）")
    nu.add_argument("--note-id", required=True)
    nu.add_argument("--title")
    nu.add_argument("--content")
    nu.add_argument("--tags", nargs="*")
    add_write(nu)
    nu.set_defaults(func=cmd_note_update)

    nd = sub.add_parser("note-delete", help="🔴 删除笔记（双重闸门，按不可逆对待）")
    nd.add_argument("--note-id", required=True)
    nd.add_argument("--i-understand-deletion-may-be-permanent", action="store_true",
                    help="确认已知官方删除 bug 与误删风险")
    add_write(nd)
    nd.set_defaults(func=cmd_note_delete)

    ap = sub.add_parser("apply", help="执行人工确认过的 JSON 计划")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--confirm", default="", help="必须填 CONFIRM 才执行")
    ap.add_argument("--dry-run", action="store_true", help="只预览计划中的动作")
    ap.add_argument("--allow-high-risk", action="store_true",
                    help="允许计划里的 note_update / note_delete")
    ap.add_argument("--only-op", nargs="*", help="只执行指定 op（调试）")
    ap.add_argument("--limit", type=int, default=0, help="最多执行前 N 个动作")
    ap.add_argument("--continue-on-error", action="store_true", help="出错继续（默认出错即停）")
    ap.set_defaults(func=cmd_apply)

    pt = sub.add_parser("plan-template", help="打印计划文件 JSON 模板")
    pt.set_defaults(func=cmd_plan_template)

    ex = sub.add_parser("export", help="打包成可移植 zip（默认不含任何凭据）")
    ex.add_argument("--out", help="输出 zip 路径（默认 getnote-toolkit-<时间戳>.zip）")
    ex.add_argument("--include-key", action="store_true",
                    help="把 config.local.json 一起打进去（⚠️ 含明文 Key，默认绝不包含）")
    ex.set_defaults(func=cmd_export)
    return p


def main():
    setup_io()
    args = build_parser().parse_args()
    try:
        # 统一数据目录：--data-dir > 环境变量 > settings.json.dataDir > 默认（仓库同级 data-getbrain）
        override = getattr(args, "data_dir", None) or os.environ.get(ENV_DATA_DIR)
        reconfigure(resolve_data_dir(override))
        # 默认目录也建好，保证 doctor / 全新解压包开箱即用
        init_layout(DATA_DIR)
        return args.func(args)
    except ApiError as exc:
        print(f"\n❌ {redact(str(exc))}", file=sys.stderr)
        if getattr(exc, "reason", None):
            print(f"   reason={exc.reason} code={exc.code} status={exc.status}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        return 130
    except FileNotFoundError as exc:
        print(f"\n❌ 文件不存在：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
