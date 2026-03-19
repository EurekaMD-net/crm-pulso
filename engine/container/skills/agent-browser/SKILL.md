---
name: lightpanda-browser
description: Browse the web — navigate pages, read content as markdown, click buttons, fill forms, extract links, run JavaScript, and get structured data. Uses Lightpanda headless browser via MCP tools (mcp__browser__*).
allowed-tools: mcp__browser__*
---

# Browser Automation with Lightpanda

## Quick start

```
mcp__browser__goto        → Navigate to a URL
mcp__browser__markdown    → Get page content as clean markdown
mcp__browser__click       → Click an element by node ID
mcp__browser__fill        → Fill a form field
```

## Core workflow

1. Navigate: `mcp__browser__goto` with `url`
2. Read: `mcp__browser__markdown` to get page content
3. Interact: `mcp__browser__interactiveElements` to find buttons/inputs, then `click`/`fill`
4. Re-read after navigation or form submission

## Available tools (10)

### Navigation & Content

| Tool | Purpose |
|------|---------|
| `mcp__browser__goto` | Navigate to URL, load page in memory |
| `mcp__browser__markdown` | Get page as markdown (optional `url` param navigates first) |
| `mcp__browser__links` | Extract all links from the page |
| `mcp__browser__semantic_tree` | AI-optimized DOM tree for reasoning |
| `mcp__browser__structuredData` | Extract JSON-LD, OpenGraph, microdata |

### Interaction

| Tool | Purpose |
|------|---------|
| `mcp__browser__interactiveElements` | List clickable/fillable elements with `backendNodeId` |
| `mcp__browser__click` | Click element by `backendNodeId` |
| `mcp__browser__fill` | Fill text into input by `backendNodeId` and `text` |
| `mcp__browser__scroll` | Scroll page or element (optional `backendNodeId`, `x`, `y`) |

### JavaScript

| Tool | Purpose |
|------|---------|
| `mcp__browser__evaluate` | Run JavaScript in page context (`script` param, optional `url`) |

## Example: Read a web page

```
1. mcp__browser__markdown(url: "https://example.com")
   → Returns page content as markdown
```

## Example: Form submission

```
1. mcp__browser__goto(url: "https://example.com/login")
2. mcp__browser__interactiveElements()
   → Returns list with backendNodeId for each input/button
3. mcp__browser__fill(backendNodeId: 5, text: "user@example.com")
4. mcp__browser__fill(backendNodeId: 8, text: "password123")
5. mcp__browser__click(backendNodeId: 12)
6. mcp__browser__markdown()
   → Check the result page
```

## Example: Extract links from a page

```
1. mcp__browser__links(url: "https://news.ycombinator.com")
   → Returns all links with text and href
```

## Notes

- Pages persist in memory within a session — `goto` once, then use other tools without re-navigating
- Most tools accept an optional `url` parameter to navigate before acting
- `interactiveElements` returns `backendNodeId` values — use these with `click`, `fill`, `scroll`
- JavaScript execution via `evaluate` runs in the page context (access DOM, window, etc.)
- No screenshots or PDF rendering (use `markdown` or `semantic_tree` for content extraction)
