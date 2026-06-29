# Claude Reader for Obsidian

EPUB 阅读器 + Claude 划词对话 + 莫兰迪 4 色高亮，全在 Obsidian 里完成。

## 功能

- **EPUB 渲染**：自己解析 zip（fflate），渲染成 Obsidian 原生 DOM，主题、字体自动跟随
- **划词工具条**：选中文字弹出工具条，4 色高亮 / 复制 / **AI 一键问 Claude**
- **高亮 4 色（莫兰迪）**：米黄（喜欢/想记）、雾绿（想问/待确认）、灰粉（反对/存疑）、浅蓝（AI 笔记）
- **Chat 面板**：内置 Claude 对话，划词时自动带书名、章节、引用段落进 prompt
- **流式输出**：边生成边显示
- **目录侧栏 + 进度保存**：自动按章节/滚动位置续读
- **4 种阅读主题**：跟随、纸黄、羊皮、深夜
- **非侵入式存储**：高亮存 `<vault>/.claude-reader/<book>.json`，不动 EPUB 本身
- **移动端可用**：iPad / iPhone 都行
- **支持中转站**：自定义 base URL

## 安装（BRAT）

1. Obsidian 装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 并启用
2. BRAT → Add Beta Plugin → 填 `xionglingyu51-sys/obsidian-claude-reader`
3. 启用后：
   - 左侧栏点 📚 图标打开书架
   - 或直接点击 vault 里的 `.epub` 文件
4. Settings → Claude Reader → 填 API Key / Base URL / Model

## 用法

- **打开书**：书架点封面，或直接点 .epub 文件
- **目录**：左上角列表图标
- **主题**：右上角调色板图标
- **翻章**：底部箭头
- **划线**：选中文字 → 工具条 → 点色
- **问 AI**：选中文字 → 工具条 → 点 AI（自动打开 chat 面板,带书名+章节+引文）
- **改色/删除**：点已有高亮 → 工具条

## 开发

```bash
npm install
npm run build
```
