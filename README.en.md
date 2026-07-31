[中文](README.md)

# CaseMate

> A SiYuan note plugin for test case management — automatically parse test cases from documents and track execution status.

## Features

### ✅ Completed (MVP Phase 1)

| Feature | Description |
| :--- | :--- |
| **Document Parsing** | Right-click any document → "Parse as Test Cases" → automatically extract test cases from headings. Uses heuristic parsing: a heading is considered a test case if it has list content underneath (`- steps`, `- expected`, etc.). Compatible with variable heading levels (H3, H4, etc.) |
| **One-Click Parsing** | Right-click menu "Parse as Test Cases" on the document tree |
| **Auto-Polling** | Monitors the "Test Case Document Library" (Attribute View) every 3 seconds (configurable). When a new document is added, automatically parses it and creates execution records |
| **Block Reference** | The primary key links directly to the specific test case heading in the original document — click to jump |
| **Status Auto-Fill** | New records are automatically set to "Untested" status |
| **Auto Time Recording** | When status changes to "Passed" or "Needs Fix", the execution date is automatically recorded |
| **Project Name Auto-Fill** | Automatically retrieves the parent document's name as the project name via `getHPathByID` |
| **Dedup Protection** | Checks the execution database via `getAttributeView` to prevent duplicate parsing |
| **Data Statistics** | Right-click the execution database → "Data Statistics": filter by column + keywords or **regular expressions**, group by any field (status, project name, etc.), auto-includes all status values (including custom ones like "Abandoned") |
| **Settings Persistence** | Configuration (DB IDs, polling interval, excluded keywords, etc.) persists across restarts |
| **i18n** | Chinese and English language support |

### 🚧 Planned (Future Phases)

| Feature | Description |
| :--- | :--- |
| **Visual Dashboard** | Statistics and charts for test execution progress |
| **Reports** | Export test execution reports |
| **Batch Operations** | Bulk status updates, batch re-parsing |

## How It Works

### Architecture

```
┌─ User creates a test case document ──────────────────────────┐
│  Use Markdown headings to separate test cases                │
│  ### Test Case Name                                          │
│  - Steps                                                     │
│  - Expected results                                          │
│  - Coverage                                                  │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─ Right-click → "Add to Database" ────────────────────────────┐
│  Add the document to the "Test Case Document Library" (AV)   │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─ Auto-polling detects new document ──────────────────────────┐
│  Every 3 seconds, queries /api/av/renderAttributeView        │
│  Compares with known record snapshot                         │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─ Parse & Create Execution Records ───────────────────────────┐
│  1. Get document content via /api/block/getBlockKramdown     │
│  2. Heuristically extract test cases (heading + list content)│
│  3. Create detached rows in the execution database           │
│  4. Set block reference (→ heading block), status, project   │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─ User changes status in Execution DB ────────────────────────┐
│  Polling detects status change → auto-records execution time │
└──────────────────────────────────────────────────────────────┘
```

### Database Structure

#### Test Case Document Library (User creates this)

| Field | Type | Description |
| :--- | :--- | :--- |
| Primary Key | Block (auto) | References the test case document |
| Created Time | Date | When the doc was added |
| Project | Text | Custom project name |

#### Test Execution Library (User creates this)

| Field | Type | Description |
| :--- | :--- | :--- |
| Primary Key | Block (auto) | References the specific test case heading → click to jump |
| Project Name | Text | Auto-filled from parent document name |
| Status | Select | Untested / Passed / Needs Fix |
| Execution Date | Date | Auto-filled when status changes |

### Key APIs Used

| API | Purpose |
| :--- | :--- |
| `POST /api/av/renderAttributeView` | Query database content |
| `POST /api/av/getAttributeView` | Get raw database definition (item IDs) |
| `POST /api/av/appendAttributeViewDetachedBlocksWithValues` | Create detached rows |
| `POST /api/av/setAttributeViewBlockAttr` | Update cell values (block ref, status, date) |
| `POST /api/block/getBlockKramdown` | Get document content in Markdown |
| `POST /api/filetree/getHPathByID` | Get document human-readable path |
| `POST /api/filetree/getDoc` | Get document metadata (parentID) |

## Installation

1. Download the latest `package.zip` from the [Releases](https://github.com/your-repo/case-mate/releases) page
2. Unzip to `{workspace}/data/plugins/case-mate/`
3. Restart SiYuan and enable the plugin in Settings → Marketplace → Downloaded
4. Click the ✅ icon in the top bar to configure

## Configuration

| Setting | Description |
| :--- | :--- |
| Test Case DB ID | The Attribute View ID of your test case document library |
| Execution DB ID | The Attribute View ID of your test execution tracking library |
| Polling Interval | How often to check for new documents (1-30s, default 3s) |
| Excluded Keywords | Heading texts that should NOT be treated as test cases |
| Auto-record Time | Automatically fill execution date on status change |
| Clear Time on Reset | Clear execution date when reset to "Untested" |

## Usage Guide

### Step 1: Create the databases
- Create a **Test Case Document Library** (Attribute View) in any document
- The first field (Primary Key, block type) is auto-created — keep it
- Create a **Test Execution Library** with fields: Project Name (text), Status (select: Untested/Passed/Needs Fix), Execution Date (date)

### Step 2: Write test case documents
- Use Markdown headings (###, ####) for test case names
- Add list content (- steps, - expected results, etc.) under each heading

### Step 3: Parse into execution records
- **Method A (Auto)**: Add the document to the Test Case Document Library via right-click → "Add to Database"
- **Method B (Manual)**: Right-click the document → "Parse as Test Cases"

### Step 4: Track execution
- Open the Execution Library
- Change status to "Passed" or "Needs Fix" → execution date is auto-filled
- Click the primary key to jump to the specific test case in the source document

### Step 5: Statistics
- Right-click the Execution Library → "Data Statistics"
- Choose the filter column (default: case name), enter filter values
- Optionally enable **regex matching** (e.g. `^1\.(9|1[0-3])\.` to match cases 1.9 ~ 1.13)
- Choose the group dimension (status, project name, etc.) — all distinct values are counted automatically

## Development

```bash
# Install dependencies
pnpm install

# Development (with watch)
pnpm run dev:app

# Production build
pnpm run build

# Lint
pnpm run lint
```

## Version History

### v0.1.0 (MVP Phase 1)
- Implement document parsing, status auto-fill, time auto-recording, project name auto-fill
- Support right-click parsing and auto-polling detection
- Dedup protection, settings persistence, i18n (CN/EN)

### v0.1.1
- Data statistics: filter by column + keywords or regex, group by any field, dynamic status grouping
- Statistics dialog with field dropdown (no manual typing)