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
import sqlite3
import sys
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
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
SUBDIRS = ("downloads", "intermediate", "snapshots", "logs", "state", "trash")

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
TRASH = LAYOUT["trash"]
DATA_DIR = DEFAULT_DATA_DIR


def reconfigure(data_dir):
    """按最终 dataDir 重设所有输出目录（--data-dir / settings.json 生效点）。"""
    global LAYOUT, SNAPSHOTS, AUDIT, STATE, TRASH, DATA_DIR
    DATA_DIR = Path(data_dir).resolve()
    LAYOUT = init_layout(DATA_DIR)
    SNAPSHOTS = LAYOUT["snapshots"]
    AUDIT = LAYOUT["logs"]
    STATE = LAYOUT["state"]
    TRASH = LAYOUT["trash"]

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


# ── 层级清单（分类调整的依据）──────────────────────────────────────
#
# 为何要单独一个子命令：官方 topics 是**平**的（实测 /resource/knowledge/list
# 只返 id/name/scope/stats，没有 parent/folder 字段），所以「知识库 → 目录 →
# 书 → 讲 → 划线」不可能靠服务器结构表达。真实数据里能当层级的只有三样，
# 全部靠本地重建：
#   1) 知识库（topics）：最大集合，一阶；
#   2) 标签里的 system 标签（如「万维钢·精英日课6」）：就是「目录／专栏」；
#   3) reference 的 article 标题：《智能简史》5：模型思考者 → 书 + 讲。
# 本命令只读本地镜像，不调 API、不耗配额。

def _parse_md_head(path):
    """从镜像 Markdown 头部抽出分类所需的几个字段（不解析全文）。"""
    out = {"note_id": None, "type": None, "topics": [], "topic_ids": {},
           "tags": [], "tag_pairs": [], "source": None, "title": None, "url": None}
    try:
        txt = path.read_text(encoding="utf-8", errors="replace")[:4096]
    except OSError:
        return out
    m = re.search(r"- note_id: `(\d+)`", txt)
    if m:
        out["note_id"] = m.group(1)
    m = re.search(r"^- 类型: (\S+)", txt, re.M)
    if m:
        out["type"] = m.group(1)
    # 知识库/标签在 md 里是 Python 字面量列表：[{'name': 'x', 'type': 'system'}, ...]
    m = re.search(r"^- 知识库: (.+)$", txt, re.M)
    if m and m.group(1).strip() not in ("None", "[]", ""):
        raw = m.group(1)
        out["topics"] = re.findall(r"'name': '([^']+)'", raw)
        # 知识库的 id 也要留着：镜像里不带 scope，光凭名字无法区分
        # 「我的知识库」与「得到电子书书架」（两者会重名），必须靠 id 查缓存。
        for tid, nm in re.findall(r"'id': '([^']*)', 'name': '([^']+)'", raw):
            if tid and nm:
                out["topic_ids"][nm] = tid
    m = re.search(r"^- 标签: (.+)$", txt, re.M)
    if m and m.group(1).strip() not in ("None", "[]", ""):
        raw_tags = m.group(1)
        out["tags"] = re.findall(r"'name': '([^']+)'", raw_tags)
        # 标签 id 也要留着：同名不同 id 时，光凭名字会把两条不同的标签当成一个。
        # 实测存在这种情况（标签「AI」有 36117013 / 36111209 两个 id）。
        # 用「对列表」而不是 dict：同一条笔记里可能挂着两个同名不同 id 的标签，
        # 用 dict 会把其中一个悄悄吃掉（实测标签「AI」就有两个 id）。
        out["tag_pairs"] = [(tid, nm) for tid, nm in
                            re.findall(r"'id': '([^']*)', 'name': '([^']+)'", raw_tags) if tid and nm]
    m = re.search(r"^- 来源: (.+)$", txt, re.M)
    if m:
        out["source"] = m.group(1).strip()
    # 真正可读的「讲/篇」标题就在文件的 H1（`# 《智能简史》5：模型思考者`）。
    # 之前想用 `原文标题` 是错的：那个字段只在 article.title 与 title 不同时才写，
    # 实测绝大多数文件根本没有它，于是所有笔记都被归到「(非书本／单篇)」。
    m = re.search(r"^# (.+)$", txt, re.M)
    if m:
        out["title"] = m.group(1).strip()
    return out


# 载体类标签：说明「这条笔记是怎么记下来的」（录音 / 拍图 / 存链接），
# 不是「它讲什么」。早先把它们当目录，结果树里冒出「录音笔记 149 条」这种
# 伪目录——点进去全是互不相关的会议、课程、随手记，没有任何分类价值。
CARRIER_TAGS = {"录音笔记", "录音卡笔记", "AI链接笔记", "图片笔记",
                "本地录音", "录音卡", "会议记录"}
CARRIER_PREFIX = ("AI链接", "图片笔记", "录音笔")


def _is_carrier(name):
    if not name:
        return False
    return name in CARRIER_TAGS or name.startswith(CARRIER_PREFIX)


def _content_tags(head):
    """去掉「得到」与载体类标签后剩下的标签，才是真正的目录候选。"""
    return [t for t in (head.get("tags") or [])
            if t and t != "得到" and not _is_carrier(t)]


def _course_of(head):
    """一篇笔记属于哪个「目录／专栏」：优先 system 标签，其次 ref 来源。"""
    ct = _content_tags(head)
    if ct:
        return ct[0]
    return head.get("source") or "(无来源)"


def _book_of(head):
    """一篇笔记属于哪本「书」：《智能简史》5：模型思考者 → 智能简史。

    没有书名时返回 None（**不是**「(非书本／单篇)」）。
    早先给个占位名作为兜底，看起来「结构完整」，实际造出垃圾层级：
    63 个目录里有 61 个，书层只有一个子女节点叫「非书本／单篇」，
    占着树里一整层的缩进和一行点击，信息量为零。
    返回 None 让调用方直接跳过这一层，笔记抬到目录下面，少一层噪声。
    """
    art = head.get("title") or ""
    m = re.match(r"^《([^》]+)》", art)
    return m.group(1) if m else None

# ── 账号归属（persona）：一个账号，三个人 ─────────────────────────
#
# 这个 Get笔记 账号不是「一个人的知识库」，是三个人共用一个账号：
#   · 我    —— AI 平台 / 算力 / 大模型 / 国航数字化 / 飞书 / 知识管理
#   · 孩子  —— 高考 / 强基计划 / 志愿填报 / 院校专业 / 击剑训练 / 大学新生课
#   · 老婆  —— 民航服务质量管理 / 客服投诉 / 国航客服中心例会 / 暑运
# 再加 4053 篇（94%）课程与书本摘录——那是**家里一起在读**的东西，不属于某一个人。
#
# 所以「多人使用」指的是：这个账号里混着三个人的内容，
# **AI 必须先分清是谁的**。不是多人协作编辑（那件事本插件不做，见 ROADMAP §4.3）。
#
# 分不清的代价是具体的：不提纯，Agent 会把「孩子的志愿填报」算成我的工作方向，
# 把「老婆的客服例会」当成我的部门会议，然后拿一堆别人的事给我出主意。
#
# 判定只用本地镜像，不调 API。三种信号加权：
#   1) 知识库归属 +12 —— 人手动把笔记放进某个库，是最可靠的意图信号
#   2) 标题关键词 +5/个（最多算 3 个）—— 标题是作者自己起的，噪声最低
#   3) 正文关键词 +1/个（最多算 5 个）—— 正文长，单个词的说服力要压低
# 分数不够就判「未知」，不硬猜：宁可让人来指一下，也不要给 Agent 一个错的归属。
#
# 为什么不能只用关键词（实测）：269 篇自己记的笔记，纯关键词只能判出
# 我 67 / 孩子 81 / 老婆 20，还有 97 篇判不出来（36%）、4 篇两边都像。
# 所以知识库信号是主力，关键词只是补充，且必须允许人按 note_id 直接钉死。

OWNER_ME = "我"
OWNER_KID = "孩子"
OWNER_SPOUSE = "老婆"
OWNER_SHARED = "共用"
OWNER_UNKNOWN = "未知"
OWNERS = (OWNER_ME, OWNER_KID, OWNER_SPOUSE, OWNER_SHARED, OWNER_UNKNOWN)

# 「自己记的」类型：录音、会议、内部记录、本地录音、手记、图片文字、录音卡。
# 与摘录（得到课程/电子书，type 为 ref / link / class_audio 等）相对。
# 只有这批带行动项和工作方向，摘录是阅读记录。
OWN_TYPES = {"audio", "meeting", "internal_record", "local_audio",
             "plain_text", "img_text", "recorder_audio", "recorder_flash_audio"}

# 知识库 → 归属。默认值是从实测内容归纳出来的，不是猜的：
#   susan 16 篇全是「民航服务质量 / 投诉处理 / 客服中心例会」→ 老婆
#   fencing 7 篇全是击剑训练记录、university 9 篇全是强基与志愿、chinese 2 篇高考语文 → 孩子
#   aisnip 16 篇企业 AI 落地、working 9 篇国航数字化研讨、projectu 1 篇游戏开发 → 我
#   family 4 篇家庭支出与升学混放 → 共用
# 用户可以在 <dataDir>/state/personas.json 里改，不用改代码。
OWNER_KB_DEFAULT = {
    "susan": OWNER_SPOUSE,
    "fencing": OWNER_KID,
    "university": OWNER_KID,
    "chinese": OWNER_KID,
    "nemomeng的知识库": OWNER_KID,
    "aisnip": OWNER_ME,
    "working": OWNER_ME,
    "icosa": OWNER_ME,
    "projectu": OWNER_ME,
    "family": OWNER_SHARED,
}

# 关键词表。刻意避开会串台的词：
#   · 不用「国航」——我的国航数字化和老婆的国航客服中心都含它
#   · 不用「客服」——老婆的客服投诉和我的智能客服案例都含它
#   · 不用「训练」——孩子的击剑训练和大模型训练都含它
# 串台的代价是错归属，比判不出来更糟，所以宁可窄。
OWNER_KEYWORDS = {
    OWNER_SPOUSE: ("民航", "暑运", "旅客", "民航法", "服务质量", "客服中心",
                   "投诉处理", "服务协同", "航班", "例会", "服务质量管理"),
    OWNER_KID: ("高考", "强基", "志愿", "填报", "院校", "高二", "高三",
                "作文", "提分", "班主任", "家长会", "击剑", "教练",
                "分数线", "专业选择", "新生", "军训",
                # 孩子上大学之后的课堂与实验。这批是实测里最大的一块未知：
                # 15 条 recorder_audio 全是大学课堂录音，标题里没有「高考」这类词，
                # 光靠升学关键词一条都命不中。
                "格斗", "篮球", "训练记录", "课堂", "点名", "高等数学",
                "英语听力", "英语课", "写作课", "辩论", "院士", "讲座",
                "实验", "抑菌", "大肠杆菌", "细菌", "菌", "生物科学",
                "化学", "高数", "学术", "论文", "专业课", "大学",
                "祥森", "孩子成长", "大学生"),
    OWNER_ME: ("AI", "大模型", "算力", "智能体", "飞书", "知识管理",
               "数字化", "架构", "数据治理", "信管部", "云网安", "综保部",
               "项目管控", "知识库", "语料", "推理",
               # 我自己的技术/建设类笔记。同样在实测未知里占一大块：
               # 「服务器采购」「文档处理自动化」「OKR 工作记录小应用」
               # 这些明显是我在做的事，但没有任何升学或民航关键词。
               "服务器", "采购", "部署", "编程", "扣子", "CLI", "API",
               "数据库", "Agent", "提示词", "迁移", "锁屏", "自动化",
               "小应用", "产品开发", "功能测试", "爬虫", "向量",
               "Minor U", "Project U", "OpenClaw", "memory"),
}

PERSONA_KB_WEIGHT = 12
PERSONA_TITLE_WEIGHT = 5
PERSONA_TITLE_CAP = 3
PERSONA_BODY_WEIGHT = 1
PERSONA_BODY_CAP = 5
PERSONA_MIN_SCORE = 5

# 泛词：出现在标题里也**不足以单独定案**的词。
#
# 为什么需要这份清单：标题命中一个词就 +5，正好等于阈值，所以一个词就能定案。
# 实测这样定案的有 19 篇，其中两类是错的：
#   · 「实验」→ 孩子，但那篇是《AB实验：科学归因与增长的利器》，是技术书不是孩子的实验课
#   · 「论文」→ 孩子，但那篇《一页纸的诺贝尔奖论文》是「我」自己写的读书笔记
# 这些词描述的是**话题**，不是**人**。话题词谁都会用，所以它不能单独当身份证据。
# 注意：按整词比对，所以「训练记录」不会因为「记录」在表里而被误伤。
# 判定逻辑版本。**改了 _owner_of 的规则就要 +1**。
#
# 为什么需要它：索引按「配置 mtime」判断要不要重算归属。但改代码不会动配置文件，
# 于是「修好了判定规则」之后索引纹丝不动，界面上还是旧的错归属——
# 比没修更糟，因为人会以为修好了。实测踩过：把泛词闸门加上之后 index 报「未变 4321」。
PERSONA_LOGIC_VERSION = 2

PERSONA_WEAK_WORDS = frozenset((
    "实验", "论文", "大学", "学术", "课堂", "讲座", "专业课", "辩论",
    "报告", "分析", "总结", "记录", "思考", "反思", "训练", "课程",
    "专业", "学习", "考试", "竞赛", "成绩", "老师", "学校", "知识",
    "项目", "方案", "设计", "方法", "问题", "工作",
))


def _persona_path():
    return DATA_DIR / "state" / "personas.json"


def _persona_conf():
    """归属配置：内置默认 + 用户覆盖（<dataDir>/state/personas.json）。

    文件可选。坏文件不让它把整个命令带崩——退回默认，归属判错还能改，
    崩了用户就什么都拿不到。
    可覆盖三块：
      kb       知识库名 → 归属
      keywords 归属 → 关键词数组
      notes    note_id → 归属（手动钉死，优先级最高）
    """
    conf = {
        "kb": dict(OWNER_KB_DEFAULT),
        "keywords": {k: list(v) for k, v in OWNER_KEYWORDS.items()},
        "notes": {},
    }
    p = _persona_path()
    if not p.exists():
        return conf
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return conf
    if not isinstance(raw, dict):
        return conf
    if isinstance(raw.get("kb"), dict):
        for k, v in raw["kb"].items():
            if str(v) in OWNERS:
                conf["kb"][str(k)] = str(v)
    if isinstance(raw.get("keywords"), dict):
        for k, v in raw["keywords"].items():
            if str(k) in OWNERS and isinstance(v, list):
                conf["keywords"][str(k)] = [str(x) for x in v if str(x)]
    if isinstance(raw.get("notes"), dict):
        for k, v in raw["notes"].items():
            if str(v) in OWNERS:
                conf["notes"][str(k)] = str(v)
    return conf



def _persona_body(txt):
    """判归属用的正文：剥掉我们自己写的包装层，只留原文。

    镜像 md 的结构是：
        # 标题
        - note_id: ... / - 类型: ... / - 知识库: ... / - 标签: ...   ← 元信息
        ## 原文（全文字）
        <笔记原文>                        ← 只有这段能用来判归属
        ## AI 总结
        <我们生成的总结>                  ← 也不能算

    不剥的话「知识库」「AI」这些词会出现在每一篇里，所有笔记都被判成「我」。
    """
    if not txt:
        return ""
    marker = "## 原文（全文字）"
    i = txt.find(marker)
    body = txt[i + len(marker):] if i >= 0 else txt
    cut = body.find("\n## AI 总结")
    if cut >= 0:
        body = body[:cut]
    # 图片与链接必须整段去掉，实测踩到：笔记里的图片 URL 长这样
    #   ...&OSSAccessKeyId=LTAI5tADzX65bw95o2FyzDTU&Signature=...
    # 里面含「AId」，用子串匹配判关键词「AI」时**每一张带图的笔记都命中**，
    # 于是「正文含 AI」出现在一堆讲酸奶、石榴、酱香拿铁的随笔里。
    # URL 是机器产物，不代表作者说了什么，判归属时不该参与。
    body = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", body)
    body = re.sub(r"<img[^>]*>", " ", body, flags=re.I)
    body = re.sub(r"https?://\S+", " ", body)
    return body


# 空白与测试笔记：标题或正文说明「这条没有内容」。
# 为什么单独拎出来：135 篇「未知」里有 20 篇是空白录音、`t1`/`t2`、
# 「测试笔记」这类。把它们混在「需要你指一下」的清单里，等于让人花时间去
# 处理一堆垃圾，真正该指的 30 篇会被淹掉。界面要回答「我要不要管」，
# 这批的答案是「不用管」。
_BLANK_TITLE_RE = re.compile(
    r"^(无内容.*|无具体内容.*|空白.*|空语音.*|测试笔记|test.*|t\d+|1|\s*)$", re.I)


def _is_blank_note(head, body):
    """这条是不是空白/测试笔记（没有可归属的内容）。"""
    title = (head.get("title") or "").strip()
    if _BLANK_TITLE_RE.match(title):
        return True
    plain = re.sub(r"\s+", "", body or "")
    return len(plain) < 15

def _owner_of(head, text, conf=None):
    """判一条笔记归谁。返回 (owner, score, why)。

    why 是中文理由，给人和 Agent 看「凭什么这么判」——
    没有理由的归属等于猜，用户没法复核，也就没法纠正。
    """
    conf = conf if conf is not None else _persona_conf()
    nid = str(head.get("note_id") or "")
    pin = (conf.get("notes") or {}).get(nid)
    if pin in OWNERS:
        return pin, 999, ["手动指定"]

    score = {OWNER_ME: 0, OWNER_KID: 0, OWNER_SPOUSE: 0}
    why = {OWNER_ME: [], OWNER_KID: [], OWNER_SPOUSE: []}

    for kb in (head.get("topics") or []):
        o = (conf.get("kb") or {}).get(kb)
        if o in score:
            score[o] += PERSONA_KB_WEIGHT
            why[o].append("知识库「" + kb + "」")

    title = head.get("title") or ""
    # 调用方可能传整篇文件，也可能传已剥好的正文；这里统一再剥一次，
    # 让「传错」不会静默变成「所有笔记都判成同一个人」。
    body = _persona_body(text or "")
    def _hit(word, text):
        """关键词命中判断。纯 ASCII 词要按词边界，不能子串。

        中文没有分词边界，子串就是正确做法；但 ASCII 词子串会撞：
        「AI」命中「AId」「AIs」，「SQL」命中「MySQL」。
        实测 URL 里的 OSSAccessKeyId 让「AI」命中了每一条带图笔记。
        """
        if not word or not text:
            return False
        if word.isascii():
            return re.search(r"(?<![A-Za-z0-9])" + re.escape(word) +
                             r"(?![A-Za-z0-9])", text, re.I) is not None
        return word in text

    for o, kws in (conf.get("keywords") or {}).items():
        if o not in score:
            continue
        hit_t = [w for w in kws if _hit(w, title)][:PERSONA_TITLE_CAP]
        for w in hit_t:
            score[o] += PERSONA_TITLE_WEIGHT
            why[o].append("标题含「" + w + "」")
        rest = [w for w in kws if not _hit(w, title) and _hit(w, body)][:PERSONA_BODY_CAP]
        for w in rest:
            score[o] += PERSONA_BODY_WEIGHT
            why[o].append("正文含「" + w + "」")

    ranked = sorted(score.items(), key=lambda kv: -kv[1])
    top_o, top_s = ranked[0]
    second_s = ranked[1][1]

    # —— 两条「不足以定案」的闸门 ——
    #
    # 闸门一（泛词）：唯一的证据是一个标题泛词。话题词不能当身份证据，
    #   否则《AB实验》被判给孩子、《一页纸的诺贝尔奖论文》被判给孩子（实为我写的）。
    #
    # 闸门二（摘录）：摘录是全家一起读的语料，标题里的词是**书的主题**，不是谁的标记。
    #   实测「数字化」让 171 篇得到课程摘录被判成「我」——那不是我的工作内容。
    #   摘录要定案，必须有知识库这种人为信号，或两个以上独立词。
    only_why = why[top_o]
    solo_weak = (len(only_why) == 1 and only_why[0].startswith("标题含「")
                 and only_why[0][4:-1] in PERSONA_WEAK_WORDS)
    is_excerpt = (head.get("type") or "") not in OWN_TYPES
    kb_hit = any(w.startswith("知识库「") for w in only_why)
    title_hits = sum(1 for w in only_why if w.startswith("标题含「"))

    if top_s >= PERSONA_MIN_SCORE and top_s > second_s:
        if solo_weak:
            pass  # 落到下面的兜底：泛词不足以定案
        elif is_excerpt and not kb_hit and title_hits < 2:
            pass  # 摘录仅凭单条标题词不定案，交给「共用」
        else:
            return top_o, top_s, only_why
    if top_s >= PERSONA_MIN_SCORE and top_s == second_s:
        # 两个人都像，说明这几条关键词本身就串台。交给人，别硬指。
        return OWNER_UNKNOWN, top_s, ["两边分数相同，无法判定"]

    # 分数不够：摘录大概率是全家一起读的，判「共用」；自己记的判「未知」等人来指。
    if (head.get("type") or "") in OWN_TYPES:
        return OWNER_UNKNOWN, top_s, why[top_o] or ["本地信号不足"]
    return OWNER_SHARED, top_s, ["摘录，无明确归属"]

def cmd_personas(args):
    """按人统计：这个账号里哪些内容是谁的（纯本地，不调 API）。

    这是「一个账号三个人」那个现实的入口命令。
    不做的事：不写回平台、不改笔记、不给「未知」硬塞一个猜测。
    做的事：把 269 篇自己记的按人拆开，把判不出来的挑出来让人指。
    """
    base = DATA_DIR / (getattr(args, "into", "") or "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}\n   先跑：gn.py download --into current",
              file=sys.stderr)
        return 2

    conf = _persona_conf()
    rows = []
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        if not h.get("note_id"):
            continue
        try:
            txt = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        owner, score, why = _owner_of(h, txt, conf)
        blank = _is_blank_note(h, _persona_body(txt))
        rows.append({
            "note_id": h["note_id"],
            "title": h.get("title") or "",
            "type": h.get("type") or "",
            "owner": owner,
            "score": score,
            "why": why,
            "kbs": h.get("topics") or [],
            "own": (h.get("type") or "") in OWN_TYPES,
            "blank": blank,
        })

    total = len(rows)
    by_owner = {o: 0 for o in OWNERS}
    by_owner_own = {o: 0 for o in OWNERS}
    for r in rows:
        by_owner[r["owner"]] = by_owner.get(r["owner"], 0) + 1
        if r["own"]:
            by_owner_own[r["owner"]] = by_owner_own.get(r["owner"], 0) + 1

    own_rows = [r for r in rows if r["own"]]
    # 「未知」分两堆：空白/测试笔记（不用管）和真判不出来的（要人指一下）。
    # 混在一起会让人以为有 98 件事要处理，其实其中 20 多件是空白录音。
    unknown_all = [r for r in own_rows if r["owner"] == OWNER_UNKNOWN]
    blank_rows = [r for r in unknown_all if r["blank"]]
    unknown = [r for r in unknown_all if not r["blank"]]

    # 每个人命中的知识库，用来看「这个人的内容主要堆在哪个库」
    kb_by_owner = {}
    for r in own_rows:
        if r["owner"] == OWNER_UNKNOWN:
            continue
        for kb in r["kbs"]:
            d = kb_by_owner.setdefault(r["owner"], {})
            d[kb] = d.get(kb, 0) + 1

    out = {
        "ok": True,
        "generated_at": now_iso(),
        "dir": str(base),
        "notes_total": total,
        "own_total": len(own_rows),
        "by_owner": by_owner,
        "by_owner_own": by_owner_own,
        "kb_by_owner": {k: sorted(v.items(), key=lambda x: -x[1])
                        for k, v in kb_by_owner.items()},
        "unknown_own": [{"note_id": r["note_id"], "title": r["title"][:70],
                         "type": r["type"], "why": r["why"]} for r in unknown],
        "blank_own": {"count": len(blank_rows),
                      "note": "空白/测试笔记，没有可归属的内容，不用管"},
        "conf_path": str(_persona_path()),
        "hint": ("判不出来的会留在「未知」里，不硬猜。"
                 "想指定某一条，把它写进 " + str(_persona_path()) +
                 ' 的 {"notes": {"<note_id>": "<归属>"}}。'),
    }

    if args.json:
        print(jdump(out))
        return 0

    print("=" * 72)
    print(f"账号归属盘点  ·  {out['generated_at']}")
    print(f"镜像 {total} 篇｜自己记的 {len(own_rows)} 篇｜摘录 {total - len(own_rows)} 篇")
    print("=" * 72)
    print("\n【全部笔记按归属】")
    for o in OWNERS:
        n = by_owner.get(o, 0)
        pct = (n * 100.0 / total) if total else 0
        print(f"  {o:<4} {n:>5} 篇  {pct:>5.1f}%   其中自己记的 {by_owner_own.get(o, 0):>3} 篇")
    print("\n【自己记的按人拆开】—— 只有这批带工作方向和待办")
    for o in (OWNER_ME, OWNER_KID, OWNER_SPOUSE, OWNER_SHARED, OWNER_UNKNOWN):
        n = by_owner_own.get(o, 0)
        if not n:
            continue
        kbs = list((kb_by_owner.get(o) or {}).items())
        kbs.sort(key=lambda x: -x[1])
        kb_s = "｜".join(f"{k}({c})" for k, c in kbs[:6]) if kbs else "（没有知识库）"
        print(f"  {o:<4} {n:>4} 篇   {kb_s}")
    if blank_rows:
        print(f"\n【空白/测试笔记 {len(blank_rows)} 篇】—— 不用管（没有内容可归属）")
    if unknown:
        print(f"\n【判不出来的 {len(unknown)} 篇】—— 需要你指一下（不自动猜）")
        for r in unknown[:15]:
            print(f"  · [{r['type']:<10}] {r['title'][:52]}")
            print(f"      {r['note_id']}   {'；'.join(r['why'][:3])}")
        if len(unknown) > 15:
            print(f"  … 还有 {len(unknown) - 15} 篇，用 --json 看全部")
    print(f"\n归属配置：{out['conf_path']}（可改知识库归属/关键词/单条指定）")
    return 0



def cmd_kb_scopes(args):
    """把「哪些是真知识库、哪些是得到电子书书架」写成缓存文件。

    为何需要单独一步：本地镜像的「- 知识库:」字段只有 id 和 name，**不带 scope**。
    但两者语义完全不同——
      · scope=DEFAULT   = 用户自建知识库（实测 11 个）
      · scope=BOOKSPACE = 得到电子书自动生成的「书架」，一本书一个（实测 111 个）
    两者混在一起，侧边栏树就会出现 123 个顶层节点，看着像「我有 123 个知识库」。

    这个命令只在用户手动刷新时跑一次（几次只读请求），结果落到
    <dataDir>/state/kb_scopes.json，inventory 读它给顶层节点打标签。
    """
    c = make_client(args, dry_run=False)
    out = {}
    for scope in ("DEFAULT", "BOOKSPACE"):
        page = 1
        while page <= 20:
            try:
                d = c.call("GET", "/resource/knowledge/list",
                           params={"page": page, "scope": scope, "size": 200},
                           note=f"list_topics[{scope}]")
            except ApiError as exc:
                print(f"[warn] scope={scope} page={page} 失败：{redact(str(exc))}",
                      file=sys.stderr)
                break
            topics = (d or {}).get("topics") or []
            for t in topics:
                tid = t.get("topic_id") or t.get("id")
                if not tid:
                    continue
                out[tid] = {"name": t.get("name") or "",
                            "scope": t.get("scope") or scope,
                            "note_count": ((t.get("stats") or {}).get("note_count") or 0),
                            "book": bool(t.get("book_info")),
                            "author": ((t.get("book_info") or {}).get("author") or "")}
            if not (d or {}).get("has_more") or not topics:
                break
            page += 1

    path = STATE / "kb_scopes.json"
    path.write_text(jdump({"generated_at": now_iso(), "topics": out}), encoding="utf-8")
    own = sum(1 for v in out.values() if v["scope"] == "DEFAULT")
    shelf = len(out) - own
    print(f"已写入 {path}")
    print(f"  自建知识库 {own} 个｜电子书书架 {shelf} 个｜合计 {len(out)}")
    return 0


def cmd_ids(args):
    """建/刷新唯一 ID 表（名字 → id 的对照表），并查“名字变了 ID 没跟上”。

    为什么需要：插件内部很多地方靠**名字字符串**做关联（计划文件、撤销记录、
    拖拽目标）。名字是用户可改的，一改所有映射静默失效、**而且不会报错**，
    只会变成「找不到」。这类 bug 最难查。所以要把名字到 ID 的对应关系
    沉淀成一张表，并提供一致性检查。

    数据来源全部是本地镜像（不联网）：
      - 知识库：md 头部的 `- 知识库: [{'id': ..., 'name': ...}]`
      - 标签  ：md 头部的 `- 标签: [...]`
      - 目录/书：从标题推出（没有权威 id，只做展示用，不参与关联）
      - 笔记  ：文件名 + note_id
    """
    base = (DATA_DIR / getattr(args, "into", "")) if getattr(args, "into", "") else (DATA_DIR / "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}", file=sys.stderr)
        return 2

    kbs, tags = {}, {}
    note_title = {}          # note_id → 标题（用于查「同标题不同 id」）
    scan = 0
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        nid = h.get("note_id")
        if not nid:
            continue
        scan += 1
        note_title[nid] = h.get("title") or ""
        # 知识库：id 是权威的，名字只做显示
        for nm, tid in (h.get("topic_ids") or {}).items():
            if not tid:
                continue
            rec = kbs.setdefault(tid, {"id": tid, "name": nm, "names": [], "count": 0})
            rec["count"] += 1
            if nm not in rec["names"]:
                rec["names"].append(nm)
            if nm != rec["name"]:
                rec["name"] = nm       # 取最近一次见到的名字（镜像是最新的）
        # 标签：md 里带 id，但 _parse_md_head 只抽了名字，这里再抓一次 id
        # 标签：直接用 _parse_md_head 已经解好的 tag_ids，
        # 不要再 read_text 一次（4321 个文件读两遍白耗 30 秒）。
        for tid, nm in (h.get("tag_pairs") or []):
            if not tid:
                continue
            rec = tags.setdefault(tid, {"id": tid, "name": nm, "names": [], "count": 0})
            rec["count"] += 1
            if nm not in rec["names"]:
                rec["names"].append(nm)
            if nm != rec["name"]:
                rec["name"] = nm

    payload = {
        "generated_at": now_iso(),
        "source_dir": str(base),
        "notes_scanned": scan,
        "kbs": kbs,
        "tags": tags,
    }
    out = STATE / "ids.json"
    STATE.mkdir(parents=True, exist_ok=True)
    out.write_text(jdump(payload), encoding="utf-8")

    # ── 一致性检查 ────────────────────────────────────────────────
    # 「名字变了但 ID 没跟上」的典型表现：同一个 id 在历史镜像里见过多个名字。
    drift = []
    for kind, table in (("知识库", kbs), ("标签", tags)):
        for tid, rec in table.items():
            if len(rec["names"]) > 1:
                drift.append({"kind": kind, "id": tid, "names": rec["names"],
                              "count": rec["count"]})

    # 重名：多个 id 叫同一个名字（比「同一 id 多名」更常见，也更危险：
    # 按名字选目标时会选错一个）
    dup = []
    for kind, table in (("知识库", kbs), ("标签", tags)):
        byname = {}
        for tid, rec in table.items():
            byname.setdefault(rec["name"], []).append(tid)
        for nm, tids in byname.items():
            if len(tids) > 1:
                dup.append({"kind": kind, "name": nm, "ids": tids,
                            "count": sum(table[t]["count"] for t in tids)})

    # 知识库名与标签名重复（结构性冗余，实测 110/122）
    kbnames = {r["name"] for r in kbs.values()}
    tagnames = {r["name"] for r in tags.values()}
    overlap = sorted(kbnames & tagnames)

    report = {
        "kbs": len(kbs), "tags": len(tags), "notes_scanned": scan,
        "id_renamed": drift, "same_name_multi_id": dup,
        "kb_tag_overlap": overlap, "kb_tag_overlap_count": len(overlap),
    }
    (STATE / "ids-report.json").write_text(jdump(report), encoding="utf-8")

    if getattr(args, "json", False):
        print(jdump({"ok": True, "path": str(out), "report": report}))
        return 0

    print(f"✅ ID 表已写入 {out}")
    print(f"   扫描镜像 {scan} 篇｜知识库 {len(kbs)} 个｜标签 {len(tags)} 个")
    if drift:
        print(f"\n⚠ 同一个 ID 见过多个名字（{len(drift)} 处）——按名字做关联的地方会失效：")
        for d in drift[:10]:
            print(f"   [{d['kind']}] {d['id']}: {' / '.join(d['names'])}（{d['count']} 篇）")
    if dup:
        print(f"\n⚠ 同名不同 ID（{len(dup)} 组）——按名字选目标会选错：")
        for d in dup[:10]:
            print(f"   [{d['kind']}] 「{d['name']}」→ {', '.join(d['ids'])}（{d['count']} 篇）")
    if overlap:
        print(f"\nℹ 知识库名与标签名重复 {len(overlap)} 个（结构性冗余，不一定是错）：")
        for nm in overlap[:8]:
            print(f"   「{nm}」")
        if len(overlap) > 8:
            print(f"   …其余 {len(overlap) - 8} 个见 ids-report.json")
    if not (drift or dup):
        print("\n✅ 未发现名字/ID 错位（每个 id 只有一个名字，每个名字只对应一个 id）")
    return 0


# 载物「待办」小节的标题。会议是 📋，课堂是 📝，两个都收。
# 为什么只认标题、不全文搜「待办」：实测普通正文里这个词出现得很多（「讨论待办事项」），
# 全搜会把一堆不是行动项的话当成任务。只认 AI 总结里的小节。
TODO_HEAD_RE = re.compile(r"^#{3,4}\s*(?:📋|📝)?\s*待办事项\s*$", re.M)


def _extract_todos(txt):
    """从一篇笔记的 AI 总结里抽出待办条目（纯列表行）。

    没待办就返回 []。返回空不代表「没有待办」，也可能只是这篇没写，
    所以调用方会自己看总篇数，不会把空当成「全部清完了」。
    """
    m = TODO_HEAD_RE.search(txt)
    if not m:
        return []
    tail = txt[m.end():]
    # 遇到下一个同级或更高级标题就停（不要吸进「金句精选」之类）
    stop = re.search(r"^#{2,4}\s", tail, re.M)
    if stop:
        tail = tail[:stop.start()]
    items = []
    for line in tail.splitlines():
        s = line.strip()
        if s.startswith(("- ", "* ", "• ")):
            item = s[2:].strip()
            if item and not item.startswith("无明确"):
                items.append(item)
    return items


def cmd_agent_brief(args):
    """给 AI 读的「我最近在干什么」提纯包（纯本地，不耗配额）。

    跟 summary / inventory 的区别：那两个是给**人**看结构，
    这个给 **Agent** 看内容：它需要知道用户的主要工作方向、
    已形成的结论、以及一堆没闭合的待办。

    数据源只用本地镜像，不调 API，所以随时可跑、不会因为
    限速或断网而卡住。
    """
    base = DATA_DIR / (args.into or "current")
    if not base.is_dir():
        raise ApiError(f"镜像目录不存在：{base}（先跑一次 download）")

    days = int(args.days or 0)
    cutoff = None
    if days > 0:
        cutoff = datetime.now() - timedelta(days=days)

    notes = []
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        if not h.get("note_id"):
            continue
        try:
            txt = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # 「创建: 2025-02-27 22:06:21」
        m = re.search(r"- 创建: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})", txt)
        created = None
        if m:
            try:
                created = datetime.strptime(m.group(1) + " " + m.group(2),
                                            "%Y-%m-%d %H:%M:%S")
            except ValueError:
                created = None
        if cutoff and created and created < cutoff:
            continue
        h["_txt"] = txt
        h["_created"] = created
        notes.append(h)

    if not notes:
        print(json.dumps({"ok": False, "error": "镜像里没找到笔记", "dir": str(base)},
                         ensure_ascii=False))
        return 1

    # —— 分类：只按「自己记的」与「别人的内容」分两块 ——
    # 实测 4321 篇里 4053 篇是课程/书本摘录，只有 269 篇是用户自己的
    # （会议、录音、手记）。把摘录也当成「工作内容」会得出「用户在学 200 门课」
    # 这种结论——那不是工作方向，是阅读记录。
    # OWN_TYPES 已提到模块级（归属判定也要用），这里不再重复定义。
    own = [h for h in notes if (h.get("type") or "") in OWN_TYPES]
    excerpts = [h for h in notes if h not in own]

    # —— 待办：只从自己记的那批里抽（摘录没有行动项）——
    # 每条都带 owner。理由：实测 431 条待办里，「孩子的高考志愿填报」和
    # 「老婆的投诉处理」占了大半。不标归属，Agent 会把它们全当成
    # 「用户要做的事」，然后拿别人孩子的志愿表给用户排优先级。
    persona_conf = _persona_conf()
    todos = []
    for h in own:
        h_owner, _s, _w = _owner_of(h, h.get("_txt") or "", persona_conf)
        for it in _extract_todos(h["_txt"]):
            todos.append({
                "text": it,
                "note_id": h["note_id"],
                "title": h.get("title") or "",
                "type": h.get("type"),
                "owner": h_owner,
                "created": h["_created"].strftime("%Y-%m-%d") if h["_created"] else None,
            })

    # —— 工作内容聚合：按来源（课程/专栏/书）数数，看时间落在哪里 ——
    by_source = {}
    for h in notes:
        src = _course_of(h)
        rec = by_source.setdefault(src, {"name": src, "count": 0, "own": 0,
                                        "first": None, "last": None})
        rec["count"] += 1
        if h.get("type") in OWN_TYPES:
            rec["own"] += 1
        d = h["_created"]
        if d:
            s = d.strftime("%Y-%m-%d")
            if not rec["first"] or s < rec["first"]:
                rec["first"] = s
            if not rec["last"] or s > rec["last"]:
                rec["last"] = s
    top_sources = sorted(by_source.values(), key=lambda r: -r["count"])[: args.top]

    # —— 最近动态：按创建时间倒序，只给自己的记录 ——
    own_sorted = sorted([h for h in own if h["_created"]],
                        key=lambda h: h["_created"], reverse=True)
    recent = [{
        "note_id": h["note_id"],
        "title": h.get("title") or "",
        "type": h.get("type"),
        "created": h["_created"].strftime("%Y-%m-%d %H:%M"),
        "todos": len(_extract_todos(h["_txt"])),
    } for h in own_sorted[: args.recent]]

    # —— 自己记录的主题分布 ——
    # 标签与知识库分开数：同一名字可能在两边都出现（实测 110 个名字重复），
    # 合起来数会把两个不同的东西加在一起。
    own_tags, own_kbs = {}, {}
    n_no_tag, n_no_kb = 0, 0
    for h in own:
        # 复用 _content_tags：它已经负责剔除载体标签（「录音笔记」「会议记录」
        # 说的是「怎么记的」不是「讲什么」）和「得到」这个非主题标签。
        # 不要在这里重写一遍过滤——两处规则一旦分叉，数字就会对不上。
        keep = _content_tags(h)
        if not keep:
            n_no_tag += 1
        for t in keep:
            own_tags[t] = own_tags.get(t, 0) + 1
        kbs = [k for k in (h.get("topics") or []) if k]
        if not kbs:
            n_no_kb += 1
        for k in kbs:
            own_kbs[k] = own_kbs.get(k, 0) + 1
    own_topics = {
        "tags": [{"name": k, "count": v} for k, v in
                 sorted(own_tags.items(), key=lambda x: -x[1])[: args.top]],
        "kbs": [{"name": k, "count": v} for k, v in
                sorted(own_kbs.items(), key=lambda x: -x[1])[: args.top]],
        # 两边都空才算「没归」。用过滤后的 tag 计数：
        # 只挂「得到」的笔记，看起来有标签，实际没有主题信息。
        "untagged": sum(1 for h in own
                        if not _content_tags(h) and not (h.get("topics") or [])),
        "no_content_tag": n_no_tag,
        "no_kb": n_no_kb,
    }
    # —— 按人拆开：这是「一个账号三个人」在提纯包里的落点 ——
    # 不提纯的话，Agent 会把「孩子的志愿填报」当成我的工作方向，
    # 拿别人的事给我出主意。所以这里必须分人给，而且理由要能复核。
    by_owner = {}
    for h in own:
        ow, oscore, owhy = _owner_of(h, h.get("_txt") or "", persona_conf)
        rec = by_owner.setdefault(ow, {"owner": ow, "count": 0, "todos": 0,
                                       "kbs": {}, "why_samples": []})
        rec["count"] += 1
        rec["todos"] += len(_extract_todos(h["_txt"]))
        for kb in (h.get("topics") or []):
            rec["kbs"][kb] = rec["kbs"].get(kb, 0) + 1
        if len(rec["why_samples"]) < 3 and owhy:
            rec["why_samples"].append({"title": (h.get("title") or "")[:40],
                                       "why": owhy[:3]})
    by_owner_out = []
    for ow in OWNERS:
        rec = by_owner.get(ow)
        if not rec:
            continue
        by_owner_out.append({
            "owner": ow,
            "count": rec["count"],
            "todos": rec["todos"],
            "kbs": [{"name": k, "count": v} for k, v in
                    sorted(rec["kbs"].items(), key=lambda x: -x[1])[:8]],
            "why_samples": rec["why_samples"],
        })

    brief = {
        "ok": True,
        "generated_at": now_iso(),
        "scope": {"dir": str(base), "days": days or None,
                  "notes_total": len(notes), "own": len(own),
                  "excerpts": len(excerpts)},
        "todos_total": len(todos),
        # 待办按人汇总。放在顶级是因为 Agent 最先读的就是这个层级：
        # 「我有 165 条待办」和「我+孩子+老婆一共 431 条」是完全不同的工作量。
        "todos_by_owner": {o: sum(1 for t in todos if t["owner"] == o) for o in OWNERS},
        "todos": todos[: args.top_todos],
        "work_sources": top_sources,
        "recent_own_records": recent,
        "type_counts": {t: sum(1 for h in notes if h.get("type") == t)
                        for t in sorted({h.get("type") for h in notes})},
        # 自己记的那批按「标签 + 知识库」聚合。
        # 为什么要单独一块：上面 work_sources 是按来源数，头部全是被摘录的课程
        # （「万维钢·精英日课6 926 篇」），自己的计数是 0，看不出工作方向。
        # 只有把自己记的抽出来单独数，才能回答「我在忙什么」。
        "own_topics": own_topics,
        # 自己记的按人拆开。顺序固定为 我/孩子/老婆/共用/未知，
        # 让 Agent 读的时候位置稳定，不用靠名字猜哪块是谁。
        "by_owner": by_owner_out,
        "reading_hint": (
            "这份提纯包只含本地镜像里的结构信息，不含全文。"
            "想深入某个主题，请用 context-pack 取那一条的上下文。"
        ),
    }

    if args.json:
        print(jdump(brief))
    else:
        s = brief["scope"]
        print("=" * 72)
        print(f"工作内容提纯包  ·  {brief['generated_at']}")
        if days:
            print(f"范围：最近 {days} 天")
        print(f"笔记 {s['notes_total']} 篇｜自己记的 {s['own']}｜摘录 {s['excerpts']}")
        print("=" * 72)
        print(f"\n【没合上的待办】{brief['todos_total']} 条")
        tbo = brief["todos_by_owner"]
        nz = [f"{o} {n}" for o, n in tbo.items() if n]
        if nz:
            # 一行分清「这些待办里有多少真是我的事」。
            # 只报总数会让人以为 431 条都要自己干。
            print("  按人：" + "｜".join(nz))
        if not brief["todos"]:
            print("  (没有被结构化的待办；注意这不等于事情都做完了)")
        for t in brief["todos"]:
            print(f"  · [{t['created'] or '?'}][{t.get('owner') or '?'}] {t['text'][:70]}")
            print(f"      ← {t['title'][:50]}  ({t['note_id']})")
        print(f"\n【时间主要花在】前 {len(top_sources)} 个来源")
        for r in top_sources:
            print(f"  · {r['name'][:40]:<40} {r['count']:>5} 篇"
                  f"  自己的 {r['own']:>3}"
                  f"  {r['first'] or '?'} ~ {r['last'] or '?'}")
        print(f"\n【自己记的主题】好标签 {len(own_topics['tags'])} 个｜"
              f"知识库 {len(own_topics['kbs'])} 个｜两边都没归的 {own_topics['untagged']} 篇")
        # 「没主题标签」与「没知识库」分开说：它们是两个不同的缺口，
        # 合并成一句「未归 N 篇」会让人以为是同一批笔记。
        if own_topics["no_content_tag"]:
            print(f"  · 没有主题标签（只有「得到」或载体标签）的：{own_topics['no_content_tag']} 篇")
        if own_topics["no_kb"]:
            print(f"  · 没进任何知识库的：{own_topics['no_kb']} 篇")
        if own_topics["tags"]:
            print("  标签：" + "｜".join(f"{t['name']}({t['count']})"
                                       for t in own_topics["tags"][:12]))
        if own_topics["kbs"]:
            print("  知识库：" + "｜".join(f"{k['name'][:16]}({k['count']})"
                                         for k in own_topics["kbs"][:8]))
        if not own_topics["tags"] and not own_topics["kbs"]:
            print("  (自己的记录全部未分类——这也是 AI 看不懂你在忙什么的原因)")
        # 按人一块。不打印这块的话，下面「最近自己记的」会把三个人的事
        # 混成一个列表，读的人分不清哪条是自己的。
        if by_owner_out:
            print("\n【自己记的：按人拆开】—— 同一个账号，三个人")
            for r in by_owner_out:
                kb_s = ("｜".join(f"{k['name']}({k['count']})" for k in r["kbs"][:5])
                        if r["kbs"] else "（没有知识库）")
                td = f"，未闭合待办 {r['todos']} 条" if r["todos"] else ""
                print(f"  {r['owner']:<4} {r['count']:>4} 篇{td}")
                print(f"       {kb_s}")
                if r["owner"] == OWNER_UNKNOWN and r["why_samples"]:
                    s = r["why_samples"][0]
                    print(f"       例：{s['title']}  ← {'；'.join(s['why'])}")
        print(f"\n【最近自己记的】{len(recent)} 条")
        for r in recent:
            extra = f"  [{r['todos']} 待办]" if r["todos"] else ""
            print(f"  · {r['created']}  {r['title'][:44]:<44} {r['type']}{extra}")
        print()
    return 0


    # ── 本地全文检索 ───────────────────────────────────────────────
    #
    # 为什么自己做索引，不用官方 recall：
    #   1) recall 是云端语义 Top-K，上限 10 条，且空结果不证明没有；
    #      想「把 4321 篇当知识库查」根本不够用。
    #   2) recall 要联网、吃配额。检索是最频繁的动作，不该每次都花钱。
    #   3) 官方没有按知识库过滤的参数，而「在某个库里找」正是最常用的问法。
    #
    # 分词方案（踩过坑）：
    #   · unicode61 把一整串中文当一个 token → 搜「高考」命中 0。
    #   · trigram 要求查询 ≥3 字 → 「高考」「填报」这种两字词全废，
    #     而两字词恰恰是中文里最常见的。
    #   · 所以自己切**相邻二元组**（bigram）再交给 FTS5：
    #     「志愿填报」→ 志愿 愿填 填报，两字词照样命中。
    #     代价是索引体积变大（约 2 倍原文），但 18MB 的库无所谓。
    #
    # 边界要写清楚：这是**字面检索**，不是语义检索。
    # 搜「高考」不会命中「升学考试」，除非正文里真的出现过「高考」。

# ── 静态导出用的样式与脚本（模块级，独立的两个常量）──
#
# 为什么不写进 html 模板函数里：这两个字符串很长，内嵌会淹没逻辑；
# 而且它们是「产物」的一部分，改它们不需要动导出流程。
# 都是纯内联的，不引任何外部 CDN —— 拿到目录的人可能在内网、断网。

PUBLISH_CSS = """
:root{--fg:#1a1a1a;--muted:#6b7280;--bd:#e5e7eb;--bg:#fff;--soft:#f9fafb;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--bd:#374151;
--bg:#111827;--soft:#1f2937;--acc:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 80px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:26px;line-height:1.3;margin:0 0 10px}
.meta{color:var(--muted);font-size:13px;margin-bottom:24px}
.body{white-space:pre-wrap;word-break:break-word}
.nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:22px;font-size:14px}
.item{padding:14px 0;border-bottom:1px solid var(--bd)}
.item:last-child{border-bottom:none}
.item h3{margin:0 0 4px;font-size:15px;font-weight:600}
.item p{margin:0;color:var(--muted);font-size:13px}
.tags{color:var(--muted);font-size:12px;margin-top:5px}
#q{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--bd);
border-radius:8px;background:var(--soft);color:var(--fg)}
#q:focus{outline:2px solid var(--acc);outline-offset:1px}
#hint{color:var(--muted);font-size:12.5px;margin:10px 0 16px}
mark{background:#fde68a;color:#000;padding:0 1px;border-radius:2px}
.empty{color:var(--muted);padding:20px 0}
"""

PUBLISH_JS = """
(function(){
  var box=document.getElementById('q'),list=document.getElementById('list'),
      hint=document.getElementById('hint');
  if(!box||!list||!DATA)return;
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function hl(t,q){
    if(!q)return esc(t);
    var i=t.toLowerCase().indexOf(q.toLowerCase());
    if(i<0)return esc(t);
    return esc(t.slice(0,i))+'<mark>'+esc(t.slice(i,i+q.length))+'</mark>'+
      esc(t.slice(i+q.length));
  }
  function render(q){
    q=(q||'').trim();
    var hits=DATA;
    if(q){
      var lq=q.toLowerCase();
      hits=DATA.filter(function(d){
        return d.t.toLowerCase().indexOf(lq)>=0||d.b.toLowerCase().indexOf(lq)>=0;});
    }
    hint.textContent=q?('找到 '+hits.length+' 篇'):('共 '+DATA.length+' 篇');
    if(!hits.length){list.innerHTML='<p class="empty">没有匹配的笔记。</p>';return;}
    list.innerHTML=hits.slice(0,300).map(function(d){
      var snip='';
      if(q){
        var i=d.b.toLowerCase().indexOf(q.toLowerCase());
        if(i>=0)snip=d.b.slice(Math.max(0,i-40),i+q.length+90);
      }
      if(!snip)snip=d.b.slice(0,120);
      return '<div class="item"><h3><a href="'+d.f+'">'+hl(d.t,q)+'</a></h3>'+
        '<p>'+hl(snip,q)+'…</p>'+
        (d.g?'<div class="tags">'+esc(d.g)+'</div>':'')+'</div>';}).join('');
  }
  box.addEventListener('input',function(){render(box.value);});
  render('');
})();
"""


CJK_RUN = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]+|[A-Za-z0-9]+")


def _index_tokens(text):
    """把一段文字切成 FTS5 能用的 token 串。

    中文切相邻二元组，英文数字按词小写。单字成词（如「书」「光」）保留单字。
    """
    out = []
    for seg in CJK_RUN.findall(text or ""):
        if seg[0].isascii():
            out.append(seg.lower())
        elif len(seg) == 1:
            out.append(seg)
        else:
            out.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    return " ".join(out)


def _index_path():
    return DATA_DIR / "state" / "search.db"


def _open_index(create=False):
    p = _index_path()
    if not create and not p.exists():
        return None
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def _split_md(path):
    """把镜像 md 拆成「头部元信息」与「正文」。

    正文优先取 `## 原文（全文字）` 之后；没有这一段就退回整篇。
    这样检索命中的是课程原文，而不是我们自己写的那几行元信息。
    """
    try:
        txt = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    head = _parse_md_head(path)
    if not head.get("note_id"):
        return None
    marker = "## 原文（全文字）"
    idx = txt.find(marker)
    body = txt[idx + len(marker):] if idx >= 0 else txt
    # 正文后面会再跟一段 `## AI 总结`，它是我们自己的包装层，不是原文。
    # 不截掉的话搜「总结」会命中全部 4321 篇，把真正相关的结果全冲掉。
    cut = body.find("\n## AI 总结")
    if cut >= 0:
        body = body[:cut]
    return {"head": head, "body": body.strip()}


def _make_snippet(body, q, width=90):
    """在原文里找查询词出现的位置，截一段带上下文的摘录。

    为什么要自己做而不用 FTS5 的 snippet()：
    snippet() 只能作用在**被索引的列**上，而那一列存的是二元组 token，
    截出来会是「志愿 愿填 填报」这种碎片，没法给人看。
    所以原文另存在 meta.body 里，摘录从原文取。
    """
    if not body:
        return ""
    flat = re.sub(r"\s+", " ", body)
    words = [w for w in re.split(r"\s+", (q or "").strip()) if w]
    pos = -1
    for w in words:
        pos = flat.find(w)
        if pos >= 0:
            break
    if pos < 0:
        return flat[:width] + ("…" if len(flat) > width else "")
    start = max(0, pos - width // 3)
    end = min(len(flat), start + width)
    return ("…" if start > 0 else "") + flat[start:end] + ("…" if end < len(flat) else "")


def _html_escape(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))

def _slug(title, note_id, used):
    """把标题变成安全的文件名。

    中文可以留在文件名里（现代浏览器都支持），但要挡掉路径分隔符和控制字符，
    还要处理重名（实测有同名笔记）。
    """
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", str(title or ""))[:50].strip()
    base = re.sub(r"\s+", "-", base) or str(note_id)
    name, n = base, 2
    while name in used:
        name = f"{base}-{n}"
        n += 1
    used.add(name)
    return name + ".html"

def _page(title, body, extra_head=""):
    return ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{_html_escape(title)}</title>"
            f"<style>{PUBLISH_CSS}</style>{extra_head}"
            "</head><body><div class=\"wrap\">"
            f"{body}</div></body></html>")


def cmd_publish(args):
    """把一个知识库导出成可发布的静态站点（纯本地）。

    产出的目录可以直接丢到静态服务器 / 内网共享盘 / 打包发人。
    不带凭据、不连网、只含标题/标签/正文，不含任何私有字段。
    """
    base = DATA_DIR / (getattr(args, "into", "") or "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}", file=sys.stderr)
        return 2

    want = (args.kb or "").strip()
    if not want:
        print("❌ 要给一个知识库名（--kb）。先跑 `gn.py inventory` 看有哪些库。",
              file=sys.stderr)
        return 2

    picked = []
    all_kbs = {}
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        if not h.get("note_id"):
            continue
        kbs = h.get("topics") or []
        for k in kbs:
            all_kbs[k] = all_kbs.get(k, 0) + 1
        if not any(want in k for k in kbs):
            continue
        parts = _split_md(f)
        if not parts:
            continue
        picked.append({"head": h, "body": parts["body"]})

    if not picked:
        print(f"❌ 知识库「{want}」下没有笔记（名字要能对上 topics 里的库名）",
              file=sys.stderr)
        near = [k for k in all_kbs if want[:2] and want[:2] in k]
        if near:
            print("   你是不是想找：" + "、".join(
                f"{k}({all_kbs[k]})" for k in
                sorted(near, key=lambda x: -all_kbs[x])[:6]), file=sys.stderr)
        return 2

    out = Path(args.out) if args.out else DATA_DIR / "publish" / re.sub(
        r'[\\/:*?"<>|]', "_", want)
    out.mkdir(parents=True, exist_ok=True)

    used = set()
    index_items, search_data = [], []
    for rec in picked:
        h = rec["head"]
        title = h.get("title") or h["note_id"]
        fname = _slug(title, h["note_id"], used)
        tags = h.get("tags") or []
        created = (h.get("created") or "")[:10]

        sub = " · ".join(x for x in (
            created,
            ("标签: " + "、".join(tags)) if tags else "") if x)
        body_html = (f'<div class="nav"><a href="index.html">← 返回目录</a>'
                     f'<a href="search.html">搜索</a></div>'
                     f"<h1>{_html_escape(title)}</h1>"
                     f'<div class="meta">{_html_escape(sub)}</div>'
                     f'<div class="body">{_html_escape(rec["body"])}</div>')
        (out / fname).write_text(_page(title, body_html), encoding="utf-8")

        index_items.append(
            f'<div class="item"><h3><a href="{fname}">{_html_escape(title)}</a></h3>'
            f'<div class="tags">{_html_escape(sub)}</div></div>')
        search_data.append({
            "t": title, "f": fname, "g": "、".join(tags),
            "b": re.sub(r"\s+", " ", rec["body"])[:800],
        })

    nav = '<div class="nav"><a href="search.html">搜索</a></div>'
    idx_body = (f"{nav}<h1>{_html_escape(want)}</h1>"
                f'<div class="meta">共 {len(picked)} 篇 · '
                f'导出于 {now_iso()[:10]}</div>'
                + "".join(index_items))
    (out / "index.html").write_text(_page(want, idx_body), encoding="utf-8")

    # 搜索页：数据内联成 JSON，纯前端匹配，不需要任何服务端。
    # 为什么不单独放 .js：整个目录要能双击 index.html 就用，
    # file:// 下外链 js 在某些浏览器会被 CORS 挡住。
    data_js = "var DATA=" + json.dumps(search_data, ensure_ascii=False) + ";"
    s_body = (f'<div class="nav"><a href="index.html">← 返回目录</a></div>'
              f"<h1>搜索 · {_html_escape(want)}</h1>"
              '<input id="q" placeholder="输入关键词…" autocomplete="off">'
              '<div id="hint"></div><div id="list"></div>')
    (out / "search.html").write_text(
        _page(f"搜索 · {want}", s_body,
              f"<script>{data_js}</script><script>{PUBLISH_JS}</script>"),
        encoding="utf-8")

    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1024
    print(f"[publish] 已导出到：{out}")
    print(f"[publish] {len(picked)} 篇 · {len(used)} 个页面 · {size:.0f} KB")
    print("[publish] 打开 index.html 阅读；search.html 是纯前端搜索。")
    print("[publish] 整个目录可直接打包/U 盘/内网共享，不依赖网络与凭据。")
    return 0


def cmd_index(args):
    """建/刷新本地全文索引（纯本地，不调 API、不耗配额）。

    幂等：重复跑只会更新变过的那些文件（按 note_id + 文件修改时间判断）。
    """
    base = DATA_DIR / (getattr(args, "into", "") or "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}\n   先跑：gn.py download --into current",
              file=sys.stderr)
        return 2

    files = sorted(base.glob("*.md"))
    if not files:
        print(f"❌ {base} 里没有 md 文件", file=sys.stderr)
        return 2

    conn = _open_index(create=True)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
            note_id UNINDEXED, title, body, tags, kbs,
            tokenize='unicode61'
        )
    """)
    # meta.body 存**原文**，只用于生成摘录，不参与检索。
    # 不存的话摘录只能从 token 列取，出来是碎片。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta(
            note_id TEXT PRIMARY KEY, mtime REAL, title TEXT,
            tags TEXT, kbs TEXT, created TEXT, type TEXT, body TEXT,
            owner TEXT
        )
    """)
    # 老索引没有 owner 列：增量升级，不重建（重建 4321 篇要 39 秒，改个列不值当）。
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(meta)")}
    if "owner" not in cols:
        conn.execute("ALTER TABLE meta ADD COLUMN owner TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS meta_created ON meta(created)")
    # 键值小表：存归属配置的 mtime，用来判断「配置改过没有」。
    # 只靠 md 的 mtime 判断是错的——改 personas.json 不会碰任何 md 文件。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)
    """)
    conn.commit()

    # 归属配置只读一次：每篇都读文件会把 4321 次 IO 加到建索引里。
    persona_conf = _persona_conf()
    known = {r["note_id"]: r["mtime"] for r in conn.execute("SELECT note_id, mtime FROM meta")}
    # 老索引升级后 owner 是 NULL：这些必须重算，否则按人过滤一条都搜不到，
    # 而且不会报错——最坏的那种失败。
    need_owner = {r["note_id"] for r in conn.execute(
        "SELECT note_id FROM meta WHERE owner IS NULL OR owner = ''")}

    # 归属配置改过 → 全部重算 owner。
    # 不这么做的话，「把某条从『未知』指成『老婆』」之后索引纹丝不动，
    # 而界面上看不出任何异常，只会觉得「指了没用」。
    cfg_sig = "logic" + str(PERSONA_LOGIC_VERSION) + "|mtime"
    try:
        if _persona_path().exists():
            cfg_sig += _persona_path().stat().st_mtime.__str__()
        else:
            cfg_sig += "none"
    except OSError:
        cfg_sig += "err"
    row = conn.execute("SELECT value FROM kv WHERE key = 'persona_sig'").fetchone()
    prev_sig = row["value"] if row else ""
    if cfg_sig != prev_sig:
        # 配置改了，或判定逻辑的版本变了 —— 两种都要全部重算。
        need_owner = set(known.keys())
    added = updated = skipped = failed = owner_filled = 0

    for f in files:
        try:
            mt = f.stat().st_mtime
        except OSError:
            failed += 1
            continue
        parts = _split_md(f)
        if not parts:
            failed += 1
            continue
        h, body = parts["head"], parts["body"]
        nid = h["note_id"]
        if nid in known and abs(known[nid] - mt) < 0.5 and nid not in need_owner:
            skipped += 1
            continue

        title = h.get("title") or ""
        tags = ", ".join(h.get("tags") or [])
        kbs = ", ".join(h.get("topics") or [])

        # 只补归属、正文没变的笔记：不重写 FTS 行。
        # 重写会让 FTS5 留下废弃段，实测把库从 42 MB 撑到 58 MB。
        only_owner = (nid in known and abs(known[nid] - mt) < 0.5
                      and nid in need_owner)
        if not only_owner:
            conn.execute("DELETE FROM notes WHERE note_id = ?", (nid,))
            conn.execute(
                "INSERT INTO notes(note_id, title, body, tags, kbs) VALUES (?,?,?,?,?)",
                (nid, title, _index_tokens(body), _index_tokens(tags), _index_tokens(kbs)),
            )
        owner, _oscore, _owhy = _owner_of(h, body, persona_conf)
        conn.execute(
            "INSERT OR REPLACE INTO meta(note_id, mtime, title, tags, kbs,"
            " created, type, body, owner) VALUES (?,?,?,?,?,?,?,?,?)",
            (nid, mt, title, tags, kbs, h.get("created") or "",
             h.get("type") or "", body[:4000], owner),
        )
        if nid in known:
            updated += 1
        else:
            added += 1
        if only_owner:
            owner_filled += 1

    # 镜像里已经没有的笔记，索引里也要清掉，否则会搜出不存在的东西。
    # 文件名是「<id>_<标题>.md」，不能直接拿 note_id 拼路径判断。
    on_disk = set()
    for f in files:
        p2 = _parse_md_head(f)
        if p2.get("note_id"):
            on_disk.add(p2["note_id"])
    live = {r["note_id"] for r in conn.execute("SELECT note_id FROM meta")}
    gone = [n for n in live if n not in on_disk]
    for n in gone:
        conn.execute("DELETE FROM notes WHERE note_id = ?", (n,))
        conn.execute("DELETE FROM meta WHERE note_id = ?", (n,))

    conn.commit()
    conn.execute("INSERT OR REPLACE INTO kv(key, value) VALUES('persona_sig', ?)",
                 (cfg_sig,))
    conn.commit()

    if owner_filled:
        # 补归属会产生页面空洞。整理分两步，缺一步都收不回来（实测 57.3 MB）：
        #   1) FTS5 rebuild —— VACUUM 管不到 FTS5 的影子表，必须先让它自己重建
        #   2) VACUUM        —— 再把普通表与影子表留下的空洞压掉
        # 实测 rebuild 1.3 秒 + vacuum 0.4 秒，从 57.3 MB 收到 41.6 MB。
        # 只在真的补过归属时做，平时 index 不该为了整洁每次全库重写。
        conn.execute("INSERT INTO notes(notes) VALUES('rebuild')")
        conn.commit()
        conn.execute("VACUUM")
        conn.commit()
    total = conn.execute("SELECT COUNT(*) c FROM meta").fetchone()["c"]
    size = _index_path().stat().st_size / 1024 / 1024
    conn.close()

    print(f"[index] 已建索引：{_index_path()}")
    line = (f"[index] 新增 {added}｜更新 {updated}｜未变 {skipped}｜失败 {failed}｜"
            f"清理失效 {len(gone)}")
    if owner_filled:
        line += f"｜补归属 {owner_filled}"
    print(line)
    print(f"[index] 索引内共 {total} 篇，占用 {size:.1f} MB")
    if failed:
        print(f"  ⚠ 有 {failed} 个文件读不出来（坏文件或权限问题），已跳过", file=sys.stderr)
    print("  提示：这是字面检索，不是语义检索。搜「高考」不会命中「升学考试」。")
    return 0


def _fts_query(q):
    """把用户输入拼成 FTS5 查询串。

    多个词是 **AND**（都出现才算命中），因为检索的目标是缩小范围。
    每个词内部再切 bigram 并用引号包起来，避免被当成 FTS 语法。
    """
    parts = []
    for word in re.split(r"\s+", (q or "").strip()):
        if not word:
            continue
        t = _index_tokens(word)
        if t:
            parts.append(f'"{t}"')
    return " AND ".join(parts)


def cmd_find(args):
    """检索本地索引（纯本地）。"""
    conn = _open_index()
    if conn is None:
        print("❌ 还没有索引。先跑：gn.py index", file=sys.stderr)
        return 2
    q = (args.query or "").strip()
    if not q:
        print("❌ 要给一个查询词", file=sys.stderr)
        return 2
    fq = _fts_query(q)
    if not fq:
        print("❌ 查询词里没有可检索的字符", file=sys.stderr)
        return 2

    where, params = ["notes MATCH ?"], [fq]
    if args.kb:
        # 知识库过滤作用在 meta 上；用子查询是因为 FTS 表上直接拼普通 WHERE 容易冲突
        where.append("note_id IN (SELECT note_id FROM meta WHERE kbs LIKE ?)")
        params.append(f"%{args.kb}%")
    if args.type:
        where.append("note_id IN (SELECT note_id FROM meta WHERE type = ?)")
        params.append(args.type)
    if getattr(args, "owner", ""):
        # 按人过滤。这是「一个账号三个人」的直接后果：
        # 搜「强基」时如果不过滤，出来的多半是孩子的志愿填报，
        # 而我真正想问的是我自己的工作——两者混在一个结果列表里没法用。
        where.append("note_id IN (SELECT note_id FROM meta WHERE owner = ?)")
        params.append(args.owner)

    # bm25 权重：标题命中比正文命中重要得多
    sql = ("SELECT note_id, title, rank FROM notes WHERE " + " AND ".join(where) +
           " ORDER BY bm25(notes, 0.0, 8.0, 1.0, 1.0, 1.0) LIMIT ?")
    params.append(args.limit)

    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError as e:
        print(f"❌ 查询语法有问题：{e}\n   查询串：{fq}", file=sys.stderr)
        return 2

    hits = []
    for r in rows:
        m = conn.execute("SELECT body, kbs, created, type, owner FROM meta WHERE note_id = ?",
                         (r["note_id"],)).fetchone()
        hits.append({
            "note_id": r["note_id"],
            "title": r["title"],
            "snippet": _make_snippet(m["body"] if m else "", q),
            "kb": (m["kbs"] if m else "") or "",
            "created": (m["created"] if m else "") or "",
            "type": (m["type"] if m else "") or "",
            "owner": (m["owner"] if m else "") or "",
        })

    if args.json:
        print(jdump({"ok": True, "query": q, "fts": fq, "count": len(hits), "hits": hits}))
        conn.close()
        return 0

    print(f"「{q}」命中 {len(hits)} 条（最多显示 {args.limit}）")
    for i, r in enumerate(hits, 1):
        meta_line = "  ".join(x for x in (r["created"][:10], r["owner"], r["type"],
                                          ("[" + r["kb"] + "]") if r["kb"] else "") if x)
        print(f"\n{i}. {r['title'][:60]}")
        print(f"   {r['snippet'][:170]}")
        if meta_line:
            print(f"   {meta_line}")
        print(f"   https://www.biji.com/note/{r['note_id']}")
    if not hits:
        print("\n  没有命中。这是字面检索——试试更短的关键词，或确认镜像里有这个词。")
    conn.close()
    return 0


def cmd_inventory(args):
    """本地重建层级清单：知识库 → 目录（专栏/课程）→ 书 → 讲（篇）。

    纯读本地镜像，不调 API。--json 输出给侧边栏工作台直接渲染。
    """
    base = (DATA_DIR / args.into) if getattr(args, "into", "") else (DATA_DIR / "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}\n   先跑：gn.ps1 download --into current", file=sys.stderr)
        return 2

    # 三层嵌套桶：知识库 → 目录 → 书 → [讲]
    kb_ids = {}
    tree = {}
    untopiced = 0
    no_source = 0
    total = 0
    carriers = {}
    # 知识库 id → {name, scope, book, author}；没缓存时退化为 unknown，不影响出树
    try:
        scopes = (json.loads((STATE / "kb_scopes.json").read_text(encoding="utf-8"))
                  .get("topics") or {})
    except (OSError, ValueError):
        scopes = {}
    for f in sorted(base.glob("*.md")):
        total += 1
        h = _parse_md_head(f)
        for t in (h.get("tags") or []):
            if _is_carrier(t):
                carriers[t] = carriers.get(t, 0) + 1
        rec = {"note_id": h["note_id"], "type": h["type"],
               "article": h.get("title") or "", "file": f.name}
        course = _course_of(h)
        book = _book_of(h)
        kbs = h.get("topics") or []
        if not kbs:
            untopiced += 1
            kbs = ["(未归知识库)"]
        if course == "(无来源)":
            no_source += 1
        # book 为 None 表示「没有书名」：这类笔记直接挂在目录下，
        # 不再经过一层「非书本／单篇」伪节点。用空串作内部 key，
        # 下面 build() 会自动把它展平成目录的直系子项。
        bkey = book if book else ""
        for kname in kbs:
            # topic_ids 是 名字→id（和 topics 反过来），别拿错方向
            for nm, tid in (h.get("topic_ids") or {}).items():
                if nm == kname:
                    kb_ids.setdefault(kname, tid)
                    break
            (tree.setdefault(kname, {})
                 .setdefault(course, {})
                 .setdefault(bkey, [])
                 ).append(rec)

    def build(kb_node):
        """把嵌套 dict 转成可排序的列表（大的在前），并给出每层 count。

        层级：目录（course）→ 书（book）→ 讲（lecture，同一篇文章的多条划线归一组）。
        「讲」这一层很关键：一本书通常被拆成 5–8 讲，每讲的划线分散在多个
        笔记里（一篇平均 21 条）。不按文章题目聚合的话，905 条划线就是一堆
        看不出结构的碎片。
        """
        out = []
        for course_name, books in kb_node.items():
            flat = []
            blist = []
            for book_name, notes in books.items():
                # 按「讲」的完整标题聚合；同一讲的多条划线归到同一个 lecture
                lec = {}
                for n in notes:
                    lec.setdefault(n["article"] or "(无标题)", []).append(n)
                lectures = [{"name": k, "count": len(v),
                             "notes": sorted(v, key=lambda x: x["note_id"] or "")}
                            for k, v in lec.items()]
                lectures.sort(key=lambda x: x["name"])
                if args.summary:
                    lec_out = [{"name": x["name"], "count": x["count"]} for x in lectures]
                else:
                    lec_out = lectures
                # 空 book_name = 没有书名的单篇：不造「书」层，
                # 直接把这批讲抬到目录层，前端就不会多一层空壳。
                if not book_name:
                    flat.extend(lec_out)
                    continue
                blist.append({"name": book_name, "count": len(notes),
                              "lectures": lec_out})
            blist.sort(key=lambda x: -x["count"])
            # 展平的讲统一排在真书后面，不抢排序位置。
            if flat:
                total_flat = sum(x["count"] for x in flat)
                blist.append({"name": "", "count": total_flat,
                              "lectures": flat, "flat": True})
                flat = []
            out.append({"name": course_name,
                        "count": sum(b["count"] for b in blist),
                        "books": blist})
        out.sort(key=lambda x: -x["count"])
        return out

    kbs = []
    for kname, node in tree.items():
        courses = build(node)
        kbs.append({"name": kname, "id": kb_ids.get(kname) or "",
                    "count": sum(c["count"] for c in courses),
                    "courses": courses})
    kbs.sort(key=lambda x: -x["count"])
    # 给每个顶层节点标上「这是真知识库还是电子书书架」。
    # 镜像里只有 id 和名字，必须靠 state/kb_scopes.json 才能区分；没缓存就标 unknown，
    # 不假装——否则 111 个书架会被当成 111 个知识库展示给用户。
    for kb in kbs:
        if kb["name"] == "(未归知识库)":
            # 这不是真知识库，是「还没归位的 2055 条」。必须单独一种 kind，
            # 否则它会和「未知 scope」混在一起，界面也没法把它渲染成待处理入口。
            kb["scope"], kb["kind"], kb["book_author"] = "NONE", "untopiced", ""
            continue
        info = scopes.get(kb.get("id") or "") or {}
        kb["scope"] = info.get("scope") or "UNKNOWN"
        kb["kind"] = ("book_shelf" if kb["scope"] == "BOOKSPACE"
                      else "kb" if kb["scope"] == "DEFAULT" else "unknown")
        kb["book_author"] = info.get("author") or ""

    own_kb = [x for x in kbs if x["kind"] == "kb"]
    shelves = [x for x in kbs if x["kind"] == "book_shelf"]
    unt = [x for x in kbs if x["kind"] == "untopiced"]
    unknown = [x for x in kbs if x["kind"] == "unknown"]
    data = {"dir": str(base), "total": total, "knowledge_bases": kbs,
            "own_kb_count": len(own_kb), "shelf_count": len(shelves),
            "untopiced_count": len(unt),
            "unknown_count": len(unknown),
            "carriers": dict(sorted(carriers.items(), key=lambda x: -x[1])),
            "scopes_cached": bool(scopes),
            "untopiced": untopiced, "no_source": no_source,
            "generated_at": now_iso()}
    print(jdump(data))
    return 0


# ── AI 动作的默认提示词 ──────────────────────────────────
#
# 为何放在代码里而又是「默认」：首次使用时写一份到 <dataDir>/prompts，
# 之后用户改那份文件就生效，不用改代码。
# 这样既能开箱即用，又能让用户按自己的理解重写——这是可扩展性的关键。
DEFAULT_PROMPTS = {
    "sprout": """你是我的第二大脑。下面给你一条我自己的笔记，以及它周围的上下文。

请你做「发芽」：不要复述我说过的，而是长出我没说的。具体四件事：

1. **补全**：这个框架里有没有明显缺失的一环？（例如我说了硬技能三块、软技能只说了一块）
2. **延伸**：基于同系列的其他讲、跨系列的相关段落，还有哪些相关观点我没想到？
   引用时要说清楚来自哪一条，不要编造。
3. **缺口**：我哪里说得含糊、下次可以想清楚？
4. **下一步**：给 2–3 个具体行动或思考题（不要泛泛而谈）。

约束：
- 只基于我给你的素材，不要引入外部知识充数；若素材不够，直接说「素材不足以判断」。
- 任何「相关」必须指出它和我的原话怎么相关，不要只给关键词。
- 用中文，像同事讨论，不要写成报告。
""",

    "interrogate": """你是严格的审阅者，不是助手。下面是我的笔记。

请你「审问」我：出 5 个问题，逼我确认自己真的懂了。要求：

1. 问题不要能用一个词回答，要需要我自己组织语言。
2. 至少 2 个问题要指向「我可能没想清楚的地方」（矛盾、缺证据、概念混用）。
3. 至少 1 个问题要把这条笔记和我其他笔记联系起来。
4. **不要给答案**。如果我想对答案，我会再问你。

问题按「最容易被我忽略的」到「最基础的」排序。
用中文。语气像导师，不像客服。
""",

    "link": """下面是一条中心笔记，以及若干条它「可能相关」的笔记片段。

请你判断这些相关是真相关还是假相关，并找出真正值得建立的联系：

1. 逐条判断：这条真的和中心笔记讲同一件事吗？还是只是词语撞了？
2. 挑出 1–2 条真正有洞察的联系，说清它们的共同内核是什么。
3. 如果有两条笔记实际上在说相反的事，请指出来——这往往最有价值。

约束：如果没有真联系，就直说「没有值得建立的联系」。
不要为了凑数而编造关联。用中文。
""",
}

# 内置按钮：名字 → 用哪份提示词。用户可改 actions.json 增删。
DEFAULT_ACTIONS = [
    {"id": "sprout", "label": "发芽", "prompt": "sprout",
     "hint": "联想/补全/指出缺口", "needsPack": True},
    {"id": "interrogate", "label": "审问", "prompt": "interrogate",
     "hint": "出题，逼真理解（不给答案）", "needsPack": True},
    {"id": "link", "label": "连线", "prompt": "link",
     "hint": "辨别真假相关，找出真联系", "needsPack": True},
]

PROMPT_DIR = DATA_DIR / "prompts"


def _ensure_prompts(write=True):
    """确保 prompts 目录与文件存在。返回 ({name: path}, 创建了哪些)。

    幂等：已存在的文件绝不覆盖——用户改过的提示词一个字都不能丢。
    """
    created = []
    paths = {}
    PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    for name, body in DEFAULT_PROMPTS.items():
        p = PROMPT_DIR / f"{name}.md"
        paths[name] = p
        if not p.exists() and write:
            p.write_text(body, encoding="utf-8")
            created.append(p.name)
    acts = PROMPT_DIR / "actions.json"
    paths["actions"] = acts
    if not acts.exists() and write:
        acts.write_text(jdump(DEFAULT_ACTIONS), encoding="utf-8")
        created.append(acts.name)
    return paths, created


def cmd_prompts(args):
    """列出 / 初始化 / 查看 AI 动作提示词。"""
    paths, created = _ensure_prompts(write=True)
    if created:
        print(f"[prompts] 已创建 {len(created)} 个默认文件：{', '.join(created)}")
    else:
        print("[prompts] 文件已存在（不会覆盖你改过的内容）")
    if args.name:
        key = args.name.strip()
        p = paths.get(key) or (PROMPT_DIR / f"{key}.md")
        if not p.exists():
            raise ApiError(f"没有这份提示词：{key}；现有 {sorted(DEFAULT_PROMPTS)}")
        print(f"\n===== {p.name} =====")
        print(p.read_text(encoding="utf-8"))
        return 0
    print(f"\n目录：{PROMPT_DIR}")
    for name in DEFAULT_PROMPTS:
        p = paths[name]
        size = p.stat().st_size if p.exists() else 0
        print(f"  {name:<12} {size:>5} 字节  {p}")
    acts = paths["actions"]
    if acts.exists():
        try:
            arr = json.loads(acts.read_text(encoding="utf-8"))
            print(f"\n按钮（{len(arr)} 个）：")
            for a in arr:
                print(f"  {a.get('label','?'):<8} → 提示词 {a.get('prompt','?'):<12} {a.get('hint','')}")
        except ValueError:
            print("  actions.json 解析失败，请检查 JSON 格式")
    return 0


def cmd_sprout(args):
    """查一条笔记的「发芽」状态。

    为何只能查不能生成：实测官方只开了 GET /resource/note/sprout?id=<note_id>，
    返回 {"sprout": {...}|null, "has_sprout": bool}；POST 同一路径是 404。
    所以「让 AI 发芽」这个动作必须在 DSH 侧做（见 SKILL.md），
    本命令负责把平台已有的发芽内容拿回来，不重复生成。
    """
    c = make_client(args, dry_run=False)
    nid = str(args.note_id)
    r = c.call("GET", "/resource/note/sprout", params={"id": nid}, note="note_sprout")
    if args.json:
        print(jdump(r))
        return 0
    sprout = (r or {}).get("sprout")
    has = bool((r or {}).get("has_sprout"))
    print(f"笔记 {nid}：has_sprout={has}")
    if not sprout:
        print("  平台侧还没有发芽内容。")
        print("  两条路：① 在得到 App 里对这条笔记点「发芽」；")
        print("          ② 用本插件的「发芽」按钮，由 DSH 的 AI 基于 context-pack 生成。")
        return 0
    # 结构未知时不要假装知道字段名，原样展示
    if isinstance(sprout, dict):
        for k, v in sprout.items():
            text = v if isinstance(v, str) else jdump(v)
            print(f"  {k}: {str(text)[:2000]}")
    else:
        print(str(sprout)[:4000])
    return 0


def _keywords_of(text, n=8, df_map=None):
    """从正文抽「有区分度」的关键词。

    经过两轮失败才定下来这个做法，记在后面别重蹈覆辙：
      第一版：滑窗取 2-4 字 → 抽出「整体来讲」「的东西」「后续再继」；
      第二版：加黑名单 + 提高门槛 → 好一些了，但仍会抽出「这一块」「整体来」
              这种跨词碎片，因为滑窗本身不认词边界。

    现在的做法（不需要分词库，只靠统计）：
      1) 仍然滑窗，但**任何含虚词的片段直接丢**（两端 + 内部都查）；
      2) 用 df_map（全库文档频次）算「这词是不是到处都有」：
         到处都有 = 没区分度，丢掉。这是 TF-IDF 的思路，
         而 df_map 本来就存在（inventory 扫全库时顺手能建）。
      3) 剩下的按频次排序、去冗余。

    df_map 为空时退化为「只靠虚词过滤」，会比有 df 时差，但不会崩。
    """
    if not text:
        return []
    FILLER = set("""
        整体来讲 整体来说 总的来说 基本上 实际上 其实 就是说 然后呢
        的东西 的时候 的情况 的话 对吧 好吧 是吧 对不对 有没有 能不能
        后续再 再继续 后面再 我们看 你看 这个呢 那个呢 这样的 这样的
        一些可 有可能 可能是 应该是 不会 就是为了 因为所以
        第一个 第二个 第三个 第一部分 第二部分 反正 那那个
    """.split())
    # 虚词表：只要求片段**不包含**它们，而不是只在首尾。
    # 为何这么严：滑窗一定会跨词，温和的过滤拦不住「这一块」「整体来」。
    FUNC = "的了着就是在和也都而且呢吧啊还又很最更把被给对从向吗么呀哦嗯这那他她它我你您"

    cnt = {}
    for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}", text):
        lw = w.lower()
        if lw not in FILLER and lw not in (
                "that", "this", "with", "they", "have", "from", "what", "just", "like",
                "there", "then", "than", "them", "some", "were", "will", "your"):
            cnt[lw] = cnt.get(lw, 0) + 1

    # 中文：关键改进在于**先按停顿切短句**，再在短句内部滑窗。
    #
    # 为何必须切：之前直接对整句（一串几十个汉字）滑窗，一定会跨词、
    # 跨逗号切出「体来讲」「一块儿」这种垃圾——加了黑名单也拦不住。
    # 切短句后，跨度变小，加上虚词过滤，碎片率大幅下降。
    #
    # 另一个要求：片段必须在**不同短句**里都出现（至少 2 次），
    # 只在一句里出现的是偶然词组，不是主题词。
    # 更彻底的过滤：片段必须「干净」。
    # 干净 = 首字不是虚词/数词/代词，且整段不含虚词。
    # 实测「体来讲」「一块儿」这两个典型垃圾：
    #   「体来讲」— 不含虚词，但是从「整体来讲」中间切出来的（首字「体」不虚）；
    #   「一块儿」— 含数词「一」。
    # 因此再加一条硬规则：**片段必须作为完整短句的子串出现至少 2 次**，
    # 且不能是某个更长频次更高片段的后缀。后者在下面的「去冗余」里处理。
    BAD_HEAD = "一体个把被给对从向很最更还又也都就而是的了着过"
    # 子串级排除：只要待选片段是某个填充词的**子串**，就丢掉。
    # 为何需要：黑名单只能拦全字匹配，「体来讲」是「整体来讲」的子串，
    # 拼合检查才能拦住这类“从长词中间切出来的碎片”。
    FILLER_SUB = [x for x in FILLER if len(x) >= 3]
    CLAUSE_SPLIT = re.compile(r"[，。！？；：、\n\r\t（）()【】「」“”\"'…\-—]+")
    for clause in CLAUSE_SPLIT.split(text):
        seg_hits = {}
        for run_ in re.findall(r"[\u4e00-\u9fff]+", clause):
            L = len(run_)
            for size in (4, 3):
                for i in range(0, L - size + 1):
                    seg = run_[i:i + size]
                    if seg in FILLER:
                        continue
                    if any(ch in FUNC for ch in seg):
                        continue
                    if seg[0] in BAD_HEAD:      # 不从虚词/数词/代词开头
                        continue
                    if any(seg in fs or fs in seg for fs in FILLER_SUB):
                        continue
                    seg_hits[seg] = seg_hits.get(seg, 0) + 1
        for seg in seg_hits:
            cnt[seg] = cnt.get(seg, 0) + 1

    items = [(k, v) for k, v in cnt.items() if v >= 2]

    # 区分度过滤：df_map 里出现率超过 15% 的片段视为「到处都有」，没信息量。
    # 没有这一步，任何一条录音都会抽出「工作」「时间」这类泛词。
    if df_map:
        total = max(1, len(df_map))
        items = [(k, v) for k, v in items if df_map.get(k, 0) / total <= 0.15]

    items.sort(key=lambda x: (-x[1], -len(x[0])))

    # 去冗余：短片段是长片段子串且频次不更高时，丢弃短的
    out = []
    for k, v in items:
        if any((k != o and k in o) for o in out):
            continue
        out.append(k)
        if len(out) >= n:
            break
    return out


def cmd_context_pack(args):
    """把一条笔记及其「上下文」拼成给 AI 的素材包（只读）。

    为何需要这个：AI 要能「发芽」或「审问」，光给一条笔记是不够的 ——
    它需要知道这条笔记在哪个系列里、同系列别讲了什么、本地还有哪些段落提到同样的事。
    本命令把这些从本地镜像里凑齐，一次性交给 AI 侧，避免 AI 自己乱翻 4321 个文件。

    产物结构（json）：
      { center: {...}, siblings: [...], related: [...], keywords: [...] }
    """
    base = DATA_DIR / "current"
    if not base.is_dir():
        raise ApiError(f"镜像目录不存在：{base}")
    nid = str(args.note_id)

    # 1) 扫一遍镜像，建立索引 + 关键词的「文档频次」（df）。
    #
    # df 的用途：判断一个片段是不是「到处都有」。实测发现，没有 df 时
    # 任何一条录音都会抽出「这一块」「整体来」这类碎片，把它们当关键词去
    # 找相关段落，结果全是噪声。有了 df 就能把「泛词」和「真主题词」分开。
    heads = {}
    df_map = {}
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        if not h.get("note_id"):
            continue
        h["_file"] = f
        heads[h["note_id"]] = h
        # 每条笔记对同一个片段最多贡献 1 次（文档频次，不是词频）
        try:
            txt = f.read_text(encoding="utf-8", errors="replace")[:4000]
        except OSError:
            continue
        seen = set()
        for run_ in re.findall(r"[\u4e00-\u9fff]+", txt):
            L = len(run_)
            for size in (3, 4):
                for i in range(0, max(0, L - size + 1)):
                    seen.add(run_[i:i + size])
        for seg in seen:
            df_map[seg] = df_map.get(seg, 0) + 1
    if nid not in heads:
        raise ApiError(f"镜像里没有笔记 {nid}（先跑一次 download）")
    center = heads[nid]
    c_course = _course_of(center)
    c_book = _book_of(center)
    c_title = center.get("title") or ""

    def body_of(h, limit=4000):
        try:
            t = h["_file"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        # 只取正文部分（跳过元数据头与 AI 总结尾巴），太长则截断
        i = t.find("## 原文")
        if i >= 0:
            t = t[i:]
        return t[:limit]

    center_body = body_of(center)
    kws = _keywords_of(center_body, args.keywords, df_map=df_map)

    # 2) 同系列的其他讲（这是最重要的上下文：同一门课的前后文）
    siblings = []
    for h in heads.values():
        if h["note_id"] == nid:
            continue
        if _course_of(h) != c_course:
            continue
        siblings.append({
            "note_id": h["note_id"],
            "title": h.get("title") or "",
            "book": _book_of(h) or "",
            "excerpt": body_of(h, 600).replace("\n", " ")[:600],
        })
    # 同一本书（=同一讲的多个划线）优先排前面
    siblings.sort(key=lambda x: (0 if x["book"] == c_book else 1, x["title"]))
    siblings = siblings[:args.limit]

    # 3) 跨系列的相关段落：用关键词在其他笔记里找
    related = []
    if kws:
        for h in heads.values():
            if h["note_id"] == nid or _course_of(h) == c_course:
                continue
            txt = body_of(h, 2500)
            hit = [k for k in kws if k in txt]
            if len(hit) >= 2:   # 至少命中 2 个关键词才算相关，避免噪声
                related.append({
                    "note_id": h["note_id"],
                    "course": _course_of(h),
                    "title": h.get("title") or "",
                    "matched": hit[:6],
                    "excerpt": txt.replace("\n", " ")[:500],
                })
    related.sort(key=lambda x: -len(x["matched"]))
    related = related[:8]

    pack = {
        "center": {
            "note_id": nid,
            "title": c_title,
            "course": c_course,
            "book": c_book or "",
            "type": center.get("type"),
            "topics": center.get("topics") or [],
            "tags": center.get("tags") or [],
            "body": center_body,
        },
        "siblings": siblings,
        "related": related,
        "keywords": kws,
        "stats": {"heads": len(heads), "siblings": len(siblings), "related": len(related)},
    }
    out = jdump(pack)
    if args.out:
        p = Path(args.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(out, encoding="utf-8")
        print(f"[context-pack] 已写 {p}（同系列 {len(siblings)}，跨系列相关 {len(related)}）")
    else:
        print(out)
    return 0


def cmd_resolve(args):
    """把一个层级路径解析成真实的 note_id 列表。

    界面里勾选的是「讲」（形如 kb/course/book/lecture），但真正发写请求需要的是
    note_id。ship 数据到浏览器再到回来一圈没必要，也很难保证一致（同名的书不少）。
    所以让界面只传路径，由这里用同一份镜像数据解析——两边用同一个函数，不会错位。

    路径用 \x1f 分隔（不用 /，因为专栏名里就可能带斜杠）。
    --level 决定精确到哪一层：kb / course / book / lecture。
    """
    base = (DATA_DIR / args.into) if getattr(args, "into", "") else (DATA_DIR / "current")
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}", file=sys.stderr)
        return 2

    want = [p for p in args.paths if p]
    hits = {p: [] for p in want}
    SEP = "\x1f"

    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        nid = h.get("note_id")
        if not nid:
            continue
        course = _course_of(h)
        book = _book_of(h)
        title = h.get("title") or "(无标题)"
        kbs = h.get("topics") or ["(未归知识库)"]
        # 路径必须和界面上的树**逐段对应**，否则勾选的层级解析不回笔记。
        # 没有书名时树里不存在「书」那一层（已展平），所以路径也要少一段：
        #   kb / course / lecture          ← 无书名
        #   kb / course / book / lecture   ← 有书名
        segs = [course] + ([book] if book else []) + [title]
        for kb in kbs:
            full = SEP.join([kb] + segs)
            for p in want:
                parts = p.split(SEP)
                # 路径前缀匹配：给了几段就比几段（让「知识库」「目录」也能整批选中）
                if len(parts) <= len(full.split(SEP)) and full.split(SEP)[:len(parts)] == parts:
                    hits[p].append(nid)

    out = []
    for p in want:
        ids = sorted(set(hits[p]))
        out.append({"path": p, "count": len(ids), "note_ids": ids})

    uniq = sorted({i for o in out for i in o["note_ids"]})
    print(jdump({"resolved": out, "total_unique": len(uniq), "note_ids": uniq}))
    return 0



def _mutate_guard(args, c, extra_warning=None):
    banner_dry(c)
    if extra_warning:
        print(extra_warning)

def _save_to_trash(client, note_id):
    """删除前把笔记完整存一份到 <dataDir>/trash（只读 API 调用）。

    为何不靠平台回收站：官方 FAQ 自列「删除后直接彻底删除、未进回收站」。
    既然平台不保证，删除就得自带副本。格式选 Markdown 而不是原始 JSON：
    真出事的时候，人需要的是能直接读和救回来的文本，不是要解析的 payload。

    局限（不遮掩）：note_id 由服务端分配，重建成新笔记后 ID 会变，
    所以这只是「内容救得回来」，不是「可逆操作」。界面上必须这么说。
    """
    detail = client.detail(sid(note_id))
    # 实测形状是 {"note": {...}}；早期版本曾用 {"data": {...}}，两种都接。
    data = None
    if isinstance(detail, dict):
        for key in ("note", "data", "result"):
            cand = detail.get(key)
            if isinstance(cand, dict) and cand:
                data = cand
                break
        if data is None and detail.get("content"):
            data = detail
    if not isinstance(data, dict) or not data:
        raise RuntimeError("note/detail 返回空，不敢删")
    # 正文可能在 content，也可能只有 ref_content，都当作正文兜底
    body_text = (data.get("content") or data.get("ref_content") or "").strip()
    if not body_text:
        raise RuntimeError("note/detail 没返回正文，不敢删")
    TRASH.mkdir(parents=True, exist_ok=True)
    title = (data.get("title") or data.get("display_title") or "(无标题)").strip()
    safe = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", title)[:60].strip() or "note"
    out = TRASH / f"{sid(note_id)}_{safe}.md"
    body = [
        f"# {title}",
        "",
        f"- note_id: `{sid(note_id)}`",
        f"- 已删除于: {now_iso()}",
        f"- 类型: {data.get('note_type') or data.get('entry_type') or ''}",
        f"- 原始链接: {data.get('note_url') or ('https://www.biji.com/note/' + sid(note_id))}",
        "",
        "## 原文（删除前备份）",
        "",
        body_text,
    ]
    out.write_text("\n".join(body), encoding="utf-8")
    # 同时留一份原始 JSON：Markdown 丢了格式，救的时候可能需要字段。
    (TRASH / f"{sid(note_id)}.json").write_text(jdump(data), encoding="utf-8")
    return out



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


def _note_body(c, note_id):
    """拿一条笔记的正文与标题。detail 的返回是 {"note": {...}}，不是 {"data": ...}。"""
    d = c.detail(sid(note_id))
    if not isinstance(d, dict):
        raise RuntimeError(f"note/detail 返回非对象：{note_id}")
    note = d.get("note") or d.get("data") or d.get("result") or d
    if not isinstance(note, dict):
        raise RuntimeError(f"note/detail 结构难以识别：{note_id}")
    body = (note.get("content") or note.get("ref_content") or "").strip()
    title = (note.get("display_title") or note.get("title") or "").strip()
    url = note.get("note_url") or ""
    return {"note_id": str(note_id), "title": title, "body": body, "url": url,
            "raw": note}


def cmd_merge(args):
    """把多条笔记的正文合并成**一条新笔记**（不删旧的，删旧另开一步）。

    为什么这么设计：
      · 平台没有「合并」接口，只能读旧正文 → 写新笔记。
      · 新笔记的 note_id 由服务端重新分配，**所有指向旧 id 的引用都会断**。
        所以不能假装这是可逆操作，默认只做「内容合并」，**绝不自动删旧**。
      · 旧笔记的正文在合成后仍然在线上，用户可以自己去核验、再决定要不要删。

    两道闸门：
      1) 不带 --apply 只输出预览与将创建的完整正文（可先看再跑）。
      2) --apply 时必须显式 --i-understand-new-id（承认会得到新 id）。
    """
    ids = [str(x).strip() for x in (args.note_ids or []) if str(x).strip()]
    if len(ids) < 2:
        print("❌ 合并至少要两条笔记（一次只能读、不能只拼一条）。", file=sys.stderr)
        return 2
    if len(ids) > 50:
        print("❌ 一次最多 50 条。多请分批（一次拼出十多万字的笔记没法读）。", file=sys.stderr)
        return 2

    c = make_client(args)
    parts, missing, titles = [], [], []
    for nid in ids:
        try:
            n = _note_body(c, nid)
        except Exception as exc:  # noqa: BLE001
            missing.append((nid, str(exc)))
            continue
        if not n["body"]:
            missing.append((nid, "正文为空，不拿它凑数"))
            continue
        titles.append(n["title"] or nid)
        parts.append((n, n["body"]))

    if missing:
        for nid, why in missing:
            print(f"❌ {nid}: {why}", file=sys.stderr)
        print("   合并要求每条都有正文；缺一条就停下，不静默跳过。", file=sys.stderr)
        return 3
    if len(parts) < 2:
        print("❌ 可用正文不足两条，无法合并。", file=sys.stderr)
        return 3

    # 默认标题：不要拿前三条标题去拼。实测那会把正文首句截进标题里
    # （「# 研究的方法 2023年9月…」），又长又难认。
    # 改成「合并 N 篇 · 第一篇的干净标题」，人能一眼看出这是什么。
    if args.title:
        title = args.title
    else:
        first = (titles[0] or "").strip().lstrip("#").strip()
        if len(first) > 30:
            first = first[:30] + "…"
        title = f"合并 {len(titles)} 篇 · {first or '未命名'}"

    # 正文拼接：每段前面写清来源（id + 原标题 + 链接），
    # 否则半年后看到一串没有出处的文字，等于把信息归了个零。
    chunks = []
    for n, body in parts:
        head = f"## 来源：{n['title'] or n['note_id']}"
        meta = f"- note_id: `{n['note_id']}`"
        if n["url"]:
            meta += f"\n- 原始链接: {n['url']}"
        chunks.append(head + "\n\n" + meta + "\n\n" + body)
    sep = "\n\n---\n\n"
    content = "\n\n".join(chunks) if args.style == "sections" else sep.join(chunks)

    print("=" * 72)
    print(f"合并预览：{len(parts)} 条 → 1 条新笔记")
    print(f"  新标题：{title}")
    print(f"  正文长度：{len(content):,} 字符")
    print("  参与合并：")
    for n, body in parts:
        print(f"    · {n['note_id']}  {n['title'][:40]:<40}  {len(body):>7,} 字")
    print("  旧笔记：**全部保留**（本命令不删任何东西）")
    print("=" * 72)

    if not args.apply:
        if args.show:
            print("\n—— 将创建的正文（前 2000 字）——\n")
            print(content[:2000])
            if len(content) > 2000:
                print(f"\n…（共 {len(content):,} 字，其余省略）")
        print("\n[DRY-RUN] 未写入。确认后加 --apply --i-understand-new-id 才会真的建。")
        return 0

    if not args.i_understand_new_id:
        print("❌ 拒绝执行：合并会创建一个**全新的 note_id**，旧引用全部断开。", file=sys.stderr)
        print("   确认你接受这一点，再加 --i-understand-new-id。", file=sys.stderr)
        return 3

    _mutate_guard(args, c,
                  "⚠️ 高危：建新笔记（新 id），旧笔记保留但不会被自动删除。")

    r = c.note_save(title, content, args.tags, args.topic_id)
    if not print_dry(r, "note/save(merge)"):
        print(jdump(r))
        new_id = ""
        if isinstance(r, dict):
            for k in ("note_id", "id"):
                if r.get(k):
                    new_id = str(r[k])
                    break
            if not new_id and isinstance(r.get("data"), dict):
                new_id = str(r["data"].get("note_id") or r["data"].get("id") or "")
        print(f"\n✅ 已建新笔记：{new_id or '(接口未返回 id，去 App 里看)'}")
        print(f"   合并了 {len(parts)} 条：{', '.join(n['note_id'] for n, _ in parts)}")
        print("   旧笔记仍在线上。要删旧请逐条走 note-delete（会先存 trash/）。")
        # 把「合并来源」落本地一份，方便以后回溯这条新笔记是从哪来
        try:
            log = STATE / f"merge-{stamp()}.json"
            STATE.mkdir(parents=True, exist_ok=True)
            log.write_text(jdump({
                "at": now_iso(), "new_note_id": new_id, "title": title,
                "sources": [{"note_id": n["note_id"], "title": n["title"], "url": n["url"]}
                            for n, _ in parts],
                "content_len": len(content),
            }), encoding="utf-8")
            print(f"   来源记录：{log}")
        except OSError:
            pass
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

    # 本地先存一份再删：平台侧删除可能不进回收站（官方 FAQ 自列），
    # 那就只能靠自己。没有这份本地副本，删除就是真单程票。
    # 注意：这是**兜底**，不是承诺可恢复——已删笔记无法用 API 写回原 note_id。
    trash_note = None
    if not args.skip_trash:
        try:
            trash_note = _save_to_trash(c, args.note_id)
            print(f"[trash] 已存本地副本：{trash_note}")
        except Exception as exc:  # noqa: BLE001
            print(f"❌ 本地副本保存失败：{exc}", file=sys.stderr)
            print("   拒绝删除：本地拿不到副本时，删了就真的没了。", file=sys.stderr)
            print("   （确实不想备份请显式加 --skip-trash）", file=sys.stderr)
            return 4

    r = c.note_delete(args.note_id)
    if not print_dry(r, "note/delete"):
        print(jdump(r))
        print("   请立刻到 App 回收站核验该笔记是否可恢复。")
        if trash_note:
            print(f"   不可恢复时，本地副本在：{trash_note}")
    return 0


def cmd_auto_classify(args):
    """把「还没归位的笔记」按规则成批归类，产出一份可直接 apply 的计划。

    为什么要做成命令而不是让模型临时拼：2055 条 × 手工勾选 = 不可能。
    但全自动跑又危险——所以这里只**生成计划**，一条都不写，等用户确认。

    规则（按顺序命中，全部可解释）：
      1) 作者系列：「万维钢·精英日课6」→ 归到【万维钢】。同名作者≥5 条才建库。
      2) 训练营：名字带「训练营」的归到【训练营】（单个≥100 条就独立建库）。
      3) 独立课程：单一目录≥30 条 → 自己一个库。
      4) 其余不动——零碎目录（平均 1.7 条）归一起只会造出新垃圾。
    """
    base = DATA_DIR / args.into
    if not base.is_dir():
        print(f"❌ 镜像目录不存在：{base}", file=sys.stderr)
        return 2

    rows = []
    for f in sorted(base.glob("*.md")):
        h = _parse_md_head(f)
        if not h.get("note_id"):
            continue
        # 默认只看「还没归库」的；--all 才把已归库的一起纳入（用于重算/微调）。
        if h.get("topics") and not args.all:
            continue
        h["course"] = _course_of(h)
        rows.append(h)
    if not rows:
        print("没有需要归位的笔记。", file=sys.stderr)
        return 0

    import collections
    cc = collections.Counter(r["course"] for r in rows)
    author_re = re.compile(r"^([^·的]{2,10})·([^·].+)$")

    def propose(r):
        course = r["course"]
        if course == "(无来源)":
            return None
        m = author_re.match(course)
        if m and cc[course] >= 3:
            return m.group(1).strip()
        if "训练营" in course:
            return course if cc[course] >= 100 else "训练营"
        if cc[course] >= 30:
            return course
        return None

    groups, skipped = {}, []
    for r in rows:
        k = propose(r)
        if k:
            groups.setdefault(k, []).append(r)
        else:
            skipped.append(r)

    # 太小的组降级为零散（如「《礼记」「哈特穆特」这种被正则误当作者的）
    keep = {k: v for k, v in groups.items() if len(v) >= args.min_group}
    for k, v in groups.items():
        if k not in keep:
            skipped.extend(v)

    if args.limit_groups:
        ordered = sorted(keep, key=lambda x: -len(keep[x]))[:args.limit_groups]
        for k in list(keep):
            if k not in ordered:
                skipped.extend(keep.pop(k))

    actions = []
    for k in sorted(keep, key=lambda x: -len(keep[x])):
        ids = [x["note_id"] for x in keep[k]]
        actions.append({"op": "kb_ensure", "reason": f"确保知识库「{k}」存在（{len(ids)} 条）",
                        "args": {"name": k,
                                 "description": f"Mgetbrain 自动归类：{k}"}})
        # 每 20 条一个动作：与官方单批上限对齐，失败时能看出是哪个块出问题。
        for i in range(0, len(ids), 20):
            chunk = ids[i:i + 20]
            actions.append({"op": "kb_batch_add",
                            "reason": f"归入「{k}」第 {i // 20 + 1} 批（{len(chunk)} 条）",
                            "args": {"topic_name": k, "note_ids": chunk}})

    plan = {"version": 1,
            "generated_at": now_iso(),
            "confirmed_by": "PENDING_USER_CONFIRM",
            "source": {"mirror": str(base), "candidates": len(rows)},
            "summary": {"groups": len(keep),
                        "notes_to_move": sum(len(v) for v in keep.values()),
                        "notes_untouched": len(skipped),
                        "actions": len(actions), "dry_run": True},
            "groups": [{"name": k, "count": len(keep[k]),
                        "courses": dict(collections.Counter(
                            x["course"] for x in keep[k]).most_common(8))}
                       for k in sorted(keep, key=lambda x: -len(keep[x]))],
            "skipped_sample": dict(collections.Counter(
                x["course"] for x in skipped).most_common(20)),
            "actions": actions,
            "_notes": ["kb_ensure 是幂等的：同名知识库已存在就直接复用，重跑不会造重复库",
                       "kb_batch_add 每动作 ≤ 20 条，apply 内部仍会切块",
                       "本计划不含任何 note_delete / note_update"]}

    out = Path(args.plan_out) if args.plan_out else (STATE / "plan.classify.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"候选笔记：{len(rows)} 条（已归类为 {len(keep)} 组）")
    for k in sorted(keep, key=lambda x: -len(keep[x])):
        print(f"  {len(keep[k]):5d} 条  【{k}】")
        for c, n in collections.Counter(x["course"] for x in keep[k]).most_common(4):
            print(f"              {n:4d}  {c}")
    print(f"\n不动：{len(skipped)} 条")
    for c, n in collections.Counter(x["course"] for x in skipped).most_common(8):
        print(f"  {n:5d}  {c}")
    print(f"\n计划：{out}")
    print(f"  动作 {len(actions)} 个｜预计 API 调用 ≈ {len(keep) * 2 + len(actions)} 次")
    print(f"\n先预览：python gn.py apply --plan {out} --dry-run")
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


# apply 专用：需要「名字 → topic_id」这种跨动作状态的 op，不放进 ALLOWED_OPS。
# 为什么不复用 kb_create：kb_create 每次都新建，计划重跑一次就多一个同名空库。
# 自动归类方案会反复生成计划、也可能中途失败后重跑，幂等是敢跑的前提。
APPLY_ONLY_OPS = {"kb_ensure"}


def _ensure_topic(c, op_args, ctx):
    """按名字确保知识库存在，返回 topic_id（已存在就复用，不重建）。"""
    name = str(op_args.get("name") or "").strip()
    if not name:
        raise ApiError("kb_ensure 缺少 name")
    if name in ctx["topic_ids"]:
        return ctx["topic_ids"][name]
    if c.dry_run:
        # 干跑不发包，拿不到真实 id。用占位符让后续 kb_batch_add 的预览仍然可读，
        # 而不是让整份计划在干跑阶段就报「topic_id 不存在」。
        ctx["topic_ids"][name] = f"__DRY_TOPIC__{name}"
        return ctx["topic_ids"][name]
    r = c.kb_create(name, str(op_args.get("description") or ""))
    tid = (r or {}).get("topic_id") or (r or {}).get("id")
    if not tid:
        raise ApiError(f"创建知识库「{name}」未返回 id：{jdump(r)[:300]}")
    ctx["topic_ids"][name] = tid
    return tid


def _collect_note_ids(actions):
    """从计划里抽出「会被改动归属」的 note_id 集合。

    只收归属类动作（加库/移库/加标/删标），**不收 note_delete**：
    删了就进回收站了，撤销不该假装能救回来（见 docs/UNDO-DESIGN.md §4）。
    """
    out = set()
    for a in actions:
        op = a.get("op")
        args = a.get("args") or {}
        if op in ("kb_batch_add", "kb_remove"):
            for nid in (args.get("note_ids") or []):
                if nid:
                    out.add(str(nid))
        elif op in ("tag_add", "tag_delete"):
            nid = args.get("note_id")
            if nid:
                out.add(str(nid))
    return sorted(out)


def _snap_ownership(c, note_ids, limit=800):
    """把每条笔记改动前的归属（知识库 + 标签）取下来。

    为何要逐个拉 detail：列表接口不带完整 topics/tags，而撤销必须知道
    「它本来在哪个库、有哪些标签」，否则 kb_remove 会把原本的归属也踢掉。

    limit：撤销只针对本次改动的笔记，通常几十到几百条。超过 800 说明计划
    本身异常（例如想把整库搬走），宁可报错也不要隐式拉几千次请求。
    """
    if len(note_ids) > limit:
        raise ApiError(
            f"本次计划要改动 {len(note_ids)} 条笔记的归属，超过单次撤销上限 {limit} 条。\n"
            f"这不是错误，而是保护：撤销记录太大会占满内存且难以解释。\n"
            f"请分批执行（apply --limit / 拆计划），或先跑 backup 再手动处理。")
    pre = {}
    for nid in note_ids:
        try:
            d = c.detail(nid)
            note = d.get("note") or d
            pre[str(nid)] = {
                "topics": [{"id": t.get("id"), "name": t.get("name")}
                            for t in (note.get("topics") or []) if t.get("id")],
                "tags": [{"id": t.get("id"), "name": t.get("name")}
                         for t in (note.get("tags") or []) if t.get("id")],
            }
        except ApiError as exc:
            # 单条拿不到不能阻断整个快照：记下来，撤销时会跳过并告知用户
            pre[str(nid)] = {"topics": [], "tags": [], "_error": redact(str(exc))}
    return pre


def cmd_undo_snapshot(args):
    """在执行写计划**之前**把归属快照存盘，供 undo 使用。

    这个命令本身是只读的（只发 GET detail），可以安全地随时跑。
    """
    plan_path = Path(args.plan)
    if not plan_path.exists():
        raise ApiError(f"计划文件不存在：{plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    actions = plan.get("actions") or []
    note_ids = _collect_note_ids(actions)
    print(f"[undo-snapshot] 计划含 {len(actions)} 个动作，需记录 {len(note_ids)} 条笔记的原归属")
    if not note_ids:
        print("[undo-snapshot] 本次不改动归属，无需快照")
        return 0

    c = make_client(args, dry_run=False)
    pre = _snap_ownership(c, note_ids, limit=getattr(args, "max_notes", 800))
    bad = [k for k, v in pre.items() if v.get("_error")]
    rec = {
        "version": 1,
        "created_at": now_iso(),
        "plan_file": str(plan_path),
        "pre_state": pre,
        "applied_ops": [],
        "status": "open",
    }
    STATE.mkdir(parents=True, exist_ok=True)
    out = STATE / f"undo-{stamp()}.json"
    out.write_text(jdump(rec), encoding="utf-8")
    print(f"[undo-snapshot] 已写 {out}（{len(pre)} 条，其中 {len(bad)} 条没拉到详情）")
    if bad:
        print(f"  拉不到的：{', '.join(bad[:5])}{' …' if len(bad) > 5 else ''}", file=sys.stderr)
    return 0


def _infer_delta(pre_entry, cur_entry):
    """算出一条笔记「应该怎么改回去」。

    用状态收敛而不是逆操作：只看「原本有没有 / 现在有没有」。
    这样即使中间有人手动改过，也不会把他改的覆盖掉（只修正我们碰过的部分）。
    """
    out = {"kb_add": [], "kb_remove": [], "tag_add": [], "tag_del": []}
    pre_t = {x["id"] for x in (pre_entry.get("topics") or []) if x.get("id")}
    cur_t = {x["id"] for x in (cur_entry.get("topics") or []) if x.get("id")}
    for tid in pre_t - cur_t:
        out["kb_add"].append(tid)
    for tid in cur_t - pre_t:
        out["kb_remove"].append(tid)

    pre_g = {x["id"] for x in (pre_entry.get("tags") or []) if x.get("id")}
    cur_g = {x["id"] for x in (cur_entry.get("tags") or []) if x.get("id")}
    for gid in pre_g - cur_g:
        out["tag_add"].append(gid)
    for gid in cur_g - pre_g:
        out["tag_del"].append(gid)
    return out


def cmd_undo(args):
    """把某次写入的归属改回原状。

    安全边界（见 docs/UNDO-DESIGN.md §4）：
      · 必须 --confirm UNDO
      · 默认 dry-run，只打印要做什么
      · 只改归属，**绝不删笔记**
      · 超过 500 条需 --allow-large
    """
    rec_path = Path(args.plan)
    if not rec_path.exists():
        raise ApiError(f"撤销记录不存在：{rec_path}")
    rec = json.loads(rec_path.read_text(encoding="utf-8"))
    if rec.get("status") == "undone":
        raise ApiError(f"这批已撤销过了（{rec.get('undone_at')}），无需重复撤销")
    pre = rec.get("pre_state") or {}
    if not pre:
        raise ApiError("撤销记录里没有 pre_state，无法还原")
    if args.confirm != "UNDO":
        raise ApiError("需显式 --confirm UNDO 才会执行撤销（防止误回退）")
    if len(pre) > 500 and not args.allow_large:
        raise ApiError(f"这批涉及 {len(pre)} 条笔记，超过 500 条需额外 --allow-large")

    c = make_client(args, dry_run=args.dry_run)
    if args.dry_run:
        print(f"[undo] --dry-run：仅预览，不发包。（{len(pre)} 条）")

    # 名称映射：kb_remove / tag_delete 需要 id，而 pre_state 里存了 name 便于人读
    name_of_topic = {}
    for v in pre.values():
        for t in (v.get("topics") or []):
            if t.get("id"):
                name_of_topic[t["id"]] = t.get("name") or t["id"]

    stats = {"kb_add": 0, "kb_remove": 0, "tag_add": 0, "tag_del": 0,
             "skipped": 0, "errors": []}
    for nid, before in pre.items():
        if before.get("_error"):
            stats["skipped"] += 1
            stats["errors"].append(f"{nid}: 快照时就丰不到详情，跳过")
            continue
        try:
            d = c.detail(nid)
            note = d.get("note") or d
            cur = {"topics": [{"id": t.get("id")} for t in (note.get("topics") or []) if t.get("id")],
                   "tags": [{"id": t.get("id")} for t in (note.get("tags") or []) if t.get("id")]}
        except ApiError as exc:
            stats["skipped"] += 1
            stats["errors"].append(f"{nid}: {redact(str(exc))}")
            continue

        delta = _infer_delta(before, cur)
        for tid in delta["kb_add"]:
            try:
                c.kb_batch_add(tid, [nid])
                stats["kb_add"] += 1
                print(f"  {nid} 补回知识库 {name_of_topic.get(tid, tid)}")
            except ApiError as exc:
                stats["errors"].append(f"{nid} kb_add {tid}: {redact(str(exc))}")
        for tid in delta["kb_remove"]:
            try:
                c.kb_remove(tid, [nid])
                stats["kb_remove"] += 1
                print(f"  {nid} 移出知识库 {name_of_topic.get(tid, tid)}")
            except ApiError as exc:
                stats["errors"].append(f"{nid} kb_remove {tid}: {redact(str(exc))}")
        for gid in delta["tag_add"]:
            try:
                c.tag_add(nid, [gid])
                stats["tag_add"] += 1
            except ApiError as exc:
                stats["errors"].append(f"{nid} tag_add {gid}: {redact(str(exc))}")
        for gid in delta["tag_del"]:
            try:
                c.tag_delete(nid, gid)
                stats["tag_del"] += 1
            except ApiError as exc:
                stats["errors"].append(f"{nid} tag_del {gid}: {redact(str(exc))}")

    print(f"\n[undo] 完成：补回库 {stats['kb_add']} / 移出库 {stats['kb_remove']} / "
          f"补标签 {stats['tag_add']} / 删标签 {stats['tag_del']}；跳过 {stats['skipped']}")
    if stats["errors"]:
        print(f"  有 {len(stats['errors'])} 条问题：", file=sys.stderr)
        for e in stats["errors"][:10]:
            print(f"    {e}", file=sys.stderr)

    if args.dry_run:
        print("[undo] dry-run 不修改撤销记录状态。")
        return 0

    rec["status"] = "undone" if not stats["errors"] else "partial"
    rec["undone_at"] = now_iso()
    rec["undo_stats"] = stats
    rec_path.write_text(jdump(rec), encoding="utf-8")
    print(f"[undo] 已标记 {rec_path.name} 为 {rec['status']}")
    return 0


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
        if a.get("op") not in ALLOWED_OPS and a.get("op") not in APPLY_ONLY_OPS:
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

    # 计划里的知识库可以只写名字（topic_name / kb_ensure），由这里换成真实 id。
    # 必须先把已有知识库读进来：不读就无法「已存在就复用」，重跑会造出一堆同名空库。
    ctx = {"topic_ids": {}}
    need_topic = any(a["op"] == "kb_ensure"
                     or (a.get("args") or {}).get("topic_name") for a in actions)
    if need_topic:
        try:
            for t in (c.topics().get("topics") or []):
                nm = t.get("name")
                tid = t.get("topic_id") or t.get("id")
                if nm and tid:
                    ctx["topic_ids"].setdefault(nm, tid)
        except ApiError as exc:
            print(f"[apply] 读取知识库列表失败：{redact(str(exc))}", file=sys.stderr)
            return 1
    results = []
    for i, a in enumerate(actions, 1):
        op = a["op"]
        print(f"  [{i}/{len(actions)}] {op}  {a.get('reason', '')}")
        try:
            if op == "kb_ensure":
                r = {"topic_id": _ensure_topic(c, a.get("args") or {}, ctx),
                     "name": (a.get("args") or {}).get("name")}
                print(f"      -> topic_id={r['topic_id']}")
            else:
                aargs = dict(a.get("args") or {})
                tname = aargs.pop("topic_name", None)
                if tname:
                    if tname not in ctx["topic_ids"]:
                        raise ApiError(
                            f"kb_batch_add 用了 topic_name「{tname}」，但计划里没有位于它之前的"
                            f" kb_ensure 动作，或那个 kb_ensure 没成功。")
                    aargs["topic_id"] = ctx["topic_ids"][tname]
                r = ALLOWED_OPS[op](c, aargs)
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
            "apply 另有 kb_ensure：按名字确保知识库存在（幂等），供 kb_batch_add 用 topic_name 引用",
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

    # 层级清单：纯读本地镜像，给侧边栏的「分类调整」页提供真实结构。
    iv = sub.add_parser("inventory", help="本地重建「知识库→目录→书→讲」层级清单（不调 API、不耗配额）")
    iv.add_argument("--into", default="current", help="镜像子目录（相对数据目录），默认 current")
    # 全量清单 577KB，侧边栏不需要每条笔记的 id。--summary 只到「讲」这一层，
    # 体积降到几十 KB；要具体笔记时再单个展开拉。
    iv.add_argument("--summary", action="store_true", help="不输出每条笔记的 id/文件名（体积小，给界面用）")
    iv.set_defaults(func=cmd_inventory)

    # 唯一 ID 表：把「名字 → id」沉淀下来，并查名字/ID 错位。
    # 动机：插件里很多关联靠名字字符串，用户改个名字就静默失效且不报错。
    ids = sub.add_parser("ids", help="建/刷新唯一 ID 表（名字→id），并检查名字与 ID 是否错位（纯本地）")
    ids.add_argument("--into", default="current", help="镜像子目录（相对数据目录），默认 current")
    ids.add_argument("--json", action="store_true", help="输出 JSON（给界面/脚本用）")
    ids.set_defaults(func=cmd_ids)

    # 面向 AI 的工作内容提纯：它要的是「你在干什么、还有什么没做完」，
    # 不是 4321 条笔记的目录树。
    # 账号归属：一个账号里混着三个人的内容，先分清是谁的，再谈分类。
    pe = sub.add_parser("personas",
                        help="按人盘点这个账号里的内容（我/孩子/老婆/共用/未知；纯本地）")
    pe.add_argument("--into", default="current", help="镜像子目录，默认 current")
    pe.add_argument("--json", action="store_true", help="输出 JSON（给界面/Agent 用）")
    pe.set_defaults(func=cmd_personas)

    ab = sub.add_parser("agent-brief",
                        help="给 AI Agent 读的工作内容提纯包（待办/主要来源/最近动态；纯本地）")
    ab.add_argument("--into", default="current", help="镜像子目录（相对数据目录），默认 current")
    ab.add_argument("--days", type=int, default=0, help="只看最近 N 天（默认全部）")
    ab.add_argument("--top", type=int, default=12, help="主要来源取前几个（默认 12）")
    ab.add_argument("--recent", type=int, default=10, help="最近自己记的取几条（默认 10）")
    ab.add_argument("--top-todos", type=int, default=40, help="待办最多列几条（默认 40）")
    ab.add_argument("--json", action="store_true", help="输出 JSON（给 Agent/脚本用）")
    ab.set_defaults(func=cmd_agent_brief)

    # 本地全文检索：检索是最频繁的动作，不该每次都联网花配额。
    ix = sub.add_parser("index", help="建/刷新本地全文索引（纯本地，sqlite FTS5）")
    ix.add_argument("--into", default="current", help="镜像子目录，默认 current")
    ix.set_defaults(func=cmd_index)

    fd = sub.add_parser("find", help="检索本地全文索引（纯本地，字面检索）")
    fd.add_argument("query", help="查询词；多个词用空格分隔（都要命中）")
    fd.add_argument("--kb", default="", help="只在这个知识库里找（名字包含即可）")
    fd.add_argument("--type", default="", help="只找这种类型（如 meeting / plain_text）")
    fd.add_argument("--owner", default="",
                    help="只找这个人的：我 / 孩子 / 老婆 / 共用 / 未知")
    fd.add_argument("--limit", type=int, default=10, help="最多返回几条，默认 10")
    fd.add_argument("--json", action="store_true", help="输出 JSON")
    fd.set_defaults(func=cmd_find)

    # 按知识库发布：导出一个自包含的静态站点，别人拿到就能读能搜。
    pb = sub.add_parser("publish", help="把一个知识库导出成静态站点（纯本地，可发布）")
    pb.add_argument("--kb", required=True, help="知识库名（包含匹配，先跑 inventory 看）")
    pb.add_argument("--out", default="", help="输出目录，默认 <dataDir>/publish/<库名>")
    pb.add_argument("--into", default="current", help="镜像子目录，默认 current")
    pb.set_defaults(func=cmd_publish)

    # 把界面选的层级路径解析成真实 note_id（不调 API）
    # —— 发芽：官方只有只读查询端点（/resource/note/sprout），实测 POST 为 404 ——
    # 所以生成本身不在本脚本里，而是由 DSH 的 AI 侧做（见 SKILL.md · 发芽）。
    sp = sub.add_parser("sprout", help="查一条笔记的「发芽」状态（只读；生成需在 App 内或由 AI 侧做）")
    sp.add_argument("--note-id", required=True, help="笔记 id")
    sp.add_argument("--json", action="store_true", help="输出原始 JSON")
    sp.set_defaults(func=cmd_sprout)

    # —— 审问/发芽的「取材」：把一条笔记及其相关上下文拼成给 AI 的素材包 ——
    ctx_p = sub.add_parser("context-pack",
                           help="把一条笔记 + 同课程其他讲 + 本地全文中相关段落拼成 AI 素材包（只读）")
    ctx_p.add_argument("--note-id", required=True, help="中心笔记 id")
    ctx_p.add_argument("--limit", type=int, default=6, help="同课程取几条相邻的讲（默认 6）")
    ctx_p.add_argument("--keywords", type=int, default=8, help="从正文抽多少个关键词用于找相关段落")
    ctx_p.add_argument("--out", default="", help="写到文件（留空则只打印）")
    ctx_p.set_defaults(func=cmd_context_pack)
    # —— 提示词管理：发芽/审问/连线 的提示词存数据目录，用户可改 ——
    pr = sub.add_parser("prompts", help="列出/初始化 AI 动作的提示词（存 <dataDir>/prompts）")
    pr.add_argument("--ensure", action="store_true", help="缺文件时用默认值创建（幂等）")
    pr.add_argument("--name", default="", help="只看某一份（sprout/interrogate/link）")
    pr.set_defaults(func=cmd_prompts)
    rv = sub.add_parser("resolve", help="把层级路径解析成 note_id 列表（不调 API、不耗配额）")
    rv.add_argument("--paths", nargs="+", required=True,
                    help="层级路径，用 \\x1f 分隔：知识库\\x1f目录\\x1f书\\x1f讲；给几段就匹配几层")
    rv.add_argument("--into", default="current", help="镜像子目录（相对数据目录），默认 current")
    rv.set_defaults(func=cmd_resolve)

    # 把「哪些是真知识库、哪些是电子书书架」拉下来缓存（只读，几次请求）。
    # 没有这一步，inventory 出来的 123 个顶层节点会把书架当成知识库展示。
    ks = sub.add_parser("kb-scopes", help="缓存每个知识库的真实 scope（区分自建库与电子书书架，只读）")
    ks.set_defaults(func=cmd_kb_scopes)

    # 自动归类：按规则把「还没归位的」成批归类，只生成计划、不写。
    ac = sub.add_parser("auto-classify",
                        help="按规则生成批量归类计划（作者系列/训练营/大课程），只写计划不动线上")
    ac.add_argument("--into", default="current", help="镜像子目录，默认 current")
    ac.add_argument("--plan-out", default="", help="计划输出路径，默认 <dataDir>/state/plan.classify.json")
    ac.add_argument("--min-group", type=int, default=5, help="少于这么多条的组降级为不动（防误建库）")
    ac.add_argument("--limit-groups", type=int, default=0, help="只处理最大的前 N 组（0=全部）")
    ac.add_argument("--all", action="store_true", help="连已经归库的也算（默认只看未归库）")
    ac.set_defaults(func=cmd_auto_classify)
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

    mg = sub.add_parser("merge", help="把多条笔记合并成一条新笔记（不删旧的；新 id 会断旧引用）")
    mg.add_argument("note_ids", nargs="+", metavar="NOTE_ID", help="要合并的 note_id（至少 2 个）")
    mg.add_argument("--title", help="新笔记标题（默认按来源自动起名）")
    mg.add_argument("--tags", nargs="*", help="给新笔记打标签（可选）")
    mg.add_argument("--topic-id", help="新笔记直接放进某个知识库（可选）")
    mg.add_argument("--style", choices=["sections", "divider"], default="sections",
                    help="拼接风格：sections=每段带来源小节；divider=只用分隔线")
    mg.add_argument("--show", action="store_true", help="干跑时打印将创建的正文前 2000 字")
    mg.add_argument("--i-understand-new-id", action="store_true",
                    help="确认已知会得到全新 note_id、旧引用会断")
    add_write(mg)
    mg.set_defaults(func=cmd_merge)

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
    nd.add_argument("--skip-trash", action="store_true",
                    help="不存本地副本（不推荐；平台侧删除可能不进回收站）")
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

    # —— 撤销：写前快照 + 状态收敛回滚（见 docs/UNDO-DESIGN.md）——
    us = sub.add_parser("undo-snapshot",
                        help="执行写计划前把笔记原归属（库/标签）快照存盘（只读）")
    us.add_argument("--plan", required=True, help="即将执行的计划文件")
    us.add_argument("--max-notes", type=int, default=800,
                    help="单次快照最多多少条（超过则报错，防止隐式拉几千次）")
    us.set_defaults(func=cmd_undo_snapshot)

    ud = sub.add_parser("undo", help="把某次写入的归属改回原状（不删笔记）")
    ud.add_argument("--plan", required=True, help="undo-<时间戳>.json 撤销记录")
    ud.add_argument("--confirm", default="", help="必须填 UNDO 才执行")
    ud.add_argument("--dry-run", action="store_true", help="只预览不写")
    ud.add_argument("--allow-large", action="store_true",
                    help="超过 500 条时需显式允许")
    ud.set_defaults(func=cmd_undo)

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
