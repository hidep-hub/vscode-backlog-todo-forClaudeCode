# BT-308 エージェント別バックログ資産の棚卸し

## 結論

共通ルールの更新元は `AGENTS.md.sample` とし、Kiro 配布元はそこへ Kiro 固有設定を追記する派生物として扱う。Claude Code の配布用ルールと、Claude/Codex のグローバル配置済み資産には更新差分があるため、今後は手コピーではなく、バックアップ付きインストーラで管理する。

## 確認結果

| 対象 | 状態 | 判定 |
| --- | --- | --- |
| `AGENTS.md.sample` | 共通ルールの最新候補 | 正本候補 |
| `.kiro/steering/backlog-hub-rules.md` | 共通ルールの複製に Kiro 固有追記を加える設計 | Kiro 配布元 |
| `~/.kiro/steering/backlog-hub-rules.md` | 配布元と SHA-256 が一致 | 配置済み・同期済み |
| `.claude/skills/install-backlog-hub/assets/backlog-hub-rules.md` | 知見昇格ルールが旧来の4箇所同期を記載 | 更新が必要 |
| `~/.claude/steering/backlog-hub-rules.md` | 配布用資産と内容が一致しない | 更新が必要 |
| `~/.codex/AGENTS.md` | Codex のペルソナなどグローバル固有内容を含み、正本候補と一致しない | 部分更新が必要 |

## 配布方針

1. `AGENTS.md.sample` を共通ルールの正本とする。
2. Claude Code 用配布資産は正本から同期する。
3. Kiro 用配布資産は共通本文を同期した上で、Kiro 固有の追記だけを保持する。
4. Claude/Codex/Kiro のインストーラは、既存ファイルをタイムスタンプ付き `.bak` に退避してから配置する。
5. Codex の `~/.codex/AGENTS.md` はペルソナ等の既存内容を保護する。インストーラは管理対象ブロックだけを更新する設計にする。

## BT-309への引き継ぎ

- Claude Code: `~/.claude/steering/backlog-hub-rules.md` と `~/.claude/CLAUDE.md` の import を安全に更新する。
- Codex: `~/.codex/AGENTS.md` の既存ペルソナを消さず、バックログルールを管理ブロックとして同期する。
- Kiro: 既存 `scripts/install-kiro-backlog.ps1` のバックアップ方式を共通パターンとして再利用する。
