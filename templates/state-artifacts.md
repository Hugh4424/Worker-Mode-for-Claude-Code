# State Artifacts Schema — worker-mode/state-artifacts/v1

## 文件体系

```
.worker-mode/state/
├── current.json          # 工头唯一常读入口（结构见 templates/state-current.json）
├── artifacts.jsonl       # 子代理落盘产物索引，每条一行 JSON
└── findings/
    ├── <id>.md           # 单条 artifact 详细正文
    └── ...
```

---

## artifacts.jsonl — 每行 schema

| 字段          | 类型     | 说明                                                              |
|---------------|----------|-------------------------------------------------------------------|
| `id`          | string   | 唯一标识，格式 `{stage}-{worker}-{yyyymmdd}-{seq}`，如 `apply-impl-20260101-001` |
| `stage`       | string   | 产生时的任务阶段名，与 current.json 的 `stage` 一致               |
| `status`      | string   | `done` / `partial` / `failed`                                     |
| `source_sha`  | string   | 写入时的 git HEAD SHA（短 8 位），便于追溯代码快照；无 git 时填 `"none"` |
| `created_at`  | string   | ISO 8601 时间戳，如 `2026-01-01T12:00:00Z`                       |
| `summary`     | string   | 一句话结论（工头读此判断是否需要翻详情）                          |
| `details_path`| string   | 指向 `findings/<id>.md` 的相对路径（相对于 `.worker-mode/state/`）|

### 示例行（一行 JSONL，此处折行仅为可读性）

```jsonl
{"id":"apply-impl-20260101-001","stage":"apply","status":"done","source_sha":"a1b2c3d4","created_at":"2026-01-01T12:00:00Z","summary":"实现 hooks/record-artifact.mjs，单测 8/8 通过","details_path":"findings/apply-impl-20260101-001.md"}
```

---

## findings/<id>.md — 详情正文

子代理将完整发现写入此文件，无结构限制，但建议包含：

```markdown
# {id} — {一句话标题}

**阶段**：{stage}  **状态**：{status}  **时间**：{created_at}

## 变更文件
- path/to/file1（新增/修改）
- path/to/file2（修改）

## 测试结论
通过 N/M，失败列表（如有）

## 实现摘要
{关键决策、取舍、ponytail 约定等}

## 阻塞 / 待确认
{如有，否则写"无"}
```

---

## 读取约定（硬规则）

1. **硬规则：工头默认只读 current.json 和 artifacts.jsonl；只有根据 artifacts.jsonl 选中某条记录时，才读取它对应的 details_path。禁止主动遍历 findings/ 目录。**
2. **禁止子代理主动遍历 findings/**：子代理回报时只回"已写入 `findings/<id>.md` + 一句话结论"，不把 findings 全文倒回主会话。防止 re-read 爆炸（N 条详情全进上下文 = 上下文膨胀根因之一）。
3. **读取入口工头统一管**：由工头决定何时、读哪条 findings；子代理不主动推送详情正文。
4. **artifacts.jsonl 只追加，不修改**：子代理通过 `tools/record-artifact.mjs` 写入，不手动拼 JSONL（防格式写坏）。
5. **current.json 只有工头写**：子代理不直接改 current.json，改了视为越界。工头在每批 worker 完成后统一更新 stage / next_steps / findings_index 等字段。

---

## ponytail 约束

```
// ponytail: artifacts.jsonl 无行数上限，超大项目（>200 条）可按 stage 分片为 artifacts-{stage}.jsonl；
//           current.json 的 findings_index 字段届时改为指向分片清单。触发条件：单文件 >500 行或工头读取明显变慢。
```
