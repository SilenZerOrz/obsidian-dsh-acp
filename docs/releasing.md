# obsidian-dsh-acp 发布 SOP（v0.3.4 起执行）

> ⚠️ 本仓库**没有 `.github/workflows/`（无 CI）** —— 没有自动建 Release 的工作流。
> 因此 **npm publish 与 GitHub Release 是两个独立的手工步骤**，容易漏第二步
> （v0.3.3 就是这样漏掉的：npm 有 0.3.3、tag 有 v0.3.3、但 Releases 页面停在 v0.3.2）。

## 前置检查
- [ ] 工作树干净（`git status --porcelain`）
- [ ] 单测全绿（`node --test test/*.test.mjs`）
- [ ] `npm pack --dry-run` 确认文件列表 + 无敏感内容
- [ ] CHANGELOG 已更新
- [ ] package.json `version` 已 bump

## 发布步骤（按顺序，勿跳）
1. [ ] `git tag -a vX.Y.Z -m "..."` && `git push origin vX.Y.Z`
2. [ ] `npm publish --access public --otp=<OTP>`
3. [ ] 验证 npm：`npm view obsidian-dsh-acp version`  # 期望 X.Y.Z
4. [ ] **创建 GitHub Release（易漏！）**
       `gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag`
       > 注：`--notes-from-tag` 与 `--repo` **不能同时用**（gh 会报错）。在仓库目录内执行，省略 `--repo`。
5. [ ] 验证：`gh release view vX.Y.Z`
6. [ ] 检查 Releases 页面 **Latest** 标签已更新（`gh release list --limit 5`）

## 回补缺失 Release
```bash
# 在仓库目录内执行（不要加 --repo，否则与 --notes-from-tag 冲突）
gh release create v0.3.3 --title "v0.3.3" --notes-from-tag
gh release list --limit 5      # 确认最新
```

## 自检命令（一键核对 npm/tag/release 三者对齐）
```bash
V=$(cat package.json | grep '"version"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
echo "package.json: $V"
npm view obsidian-dsh-acp version
git ls-remote --tags origin | grep "v$V"
gh release view "v$V" >/dev/null 2>&1 && echo "release: OK" || echo "release: MISSING → 回补"
```

## 教训
- **npm publish 与 GitHub Release 是独立步骤**。没有 CI 时（本仓库现状），
  两步不会互相触发；只做第一步就会出现「npm 有版本 / Releases 页面落后」的错位。
- `gh release create` 的 `--notes-from-tag` 与 `--repo` 互斥。
- tag 必须是 **annotated**（`git tag -a`）才能让 `--notes-from-tag` 拿到说明文字。

## 关联
- 主发布 SOP（本地）：`docs/规范/发布SOP.md`
- 分支/版本规范：`docs/规范/分支与版本规范.md`
