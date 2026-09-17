# Writer — Native Word Processing Engine & Collaborative Server

> **Reference implementation for CloudServ**: A complete, faithful port of the **core algorithms and data structures of Apache OpenOffice Writer** (`aoo-4.1.16/main/sw`, `svx`, `xmloff`, `editeng`, `starmath`) to **strict TypeScript** and **Rust (Axum + Yrs)**.

> 🤖 **Note: No line of code in this project was written by hand.** The entire codebase (client, server, tests and documentation) was produced by AI.

---

## 🌟 Core Principles & Golden Rule

1. **Zero third-party word processing libraries**:
   - No use of *ProseMirror*, *Slate*, *Quill*, *Draft.js*, *TipTap* or *CKEditor*.
   - The data model, typesetting engine, physical A4 pagination, *Point & Mark* cursor handling, undo, lists, tables, footnotes, floating frames, table of contents and ODF filters are **written and controlled entirely in-house**.
2. **The DOM is only a one-way reactive projection**:
   - No measurements, coordinates or line boundaries flow back from the DOM into the model.
   - The purely functional engine computes the exact mathematical position of every character, line and page; React only paints the computed geometry.
3. **Fully modular architecture (Web Worker ready)**:
   - The document and computation layers (`domain/document/`, `domain/engine/`, `domain/odf/`, `domain/pdf/`) are pure functions with no React imports and no DOM access.

---

## 🚀 Quick Start

```bash
# From the Writer root (React + TypeScript web client)
npm run dev        # Starts the editor at http://localhost:5174
npm test           # Runs the 27 Vitest test suites (504 tests)
npm run typecheck  # Checks strict TypeScript types (0 errors)
npm run build      # Optimized production bundle (Vite)

# From the server/ subfolder (Rust collaborative server)
cd server
cargo run          # Starts the WebSocket & REST server on 127.0.0.1:8081
cargo test         # Runs the 100 Rust unit and integration tests
```

---

## 🏛️ Complete Integration Map (OpenOffice ⇄ Writer)

The table below lists every module implemented in Writer, with its exact source files and the corresponding OpenOffice C++ components:

| Functional Area | **Writer** Source File | **OpenOffice 4.1.16** C++ Source | Ported Classes & Concepts |
| :--- | :--- | :--- | :--- |
| **AST Core & Types** | [`src/domain/document/types.ts`](src/domain/document/types.ts) | `main/sw/inc/doc.hxx`<br>`main/sw/inc/ndtxt.hxx` | `SwDoc`, `SwTxtNode`, `SwPaM`, `SwPageDesc`, `TextRun`, `ParagraphNode` |
| **Run Normalization** | [`src/domain/document/runs.ts`](src/domain/document/runs.ts) | `main/sw/source/core/txtnode/thints.cxx` | `SwpHints::MergePortions` (merges identical portions, removes empty ones) |
| **Sequential Index & Document** | [`src/domain/document/document.ts`](src/domain/document/document.ts) | `main/sw/source/core/doc/nodes.cxx` | `SwNodes`, `paragraphIndex` (flat O(N) linear reading index) |
| **Tables & Mutations** | [`src/domain/document/document.ts`](src/domain/document/document.ts)<br>[`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/doc/tblrwcl.cxx`<br>`main/sw/inc/swtable.hxx` | `SwTable::InsertRow`, `DeleteRow`, `InsertCol`, `DeleteCol`, `colSpan`, `rowSpan` |
| **Footnotes** | [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts)<br>[`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/layout/ftnfrm.cxx`<br>`main/sw/source/core/text/txtftn.cxx` | `SwFtnFrm`, `SwFtnContFrm`, `SwTxtFtn`, sequential markers `¹`, `²` |
| **Table of Contents (TOC)** | [`src/domain/document/tox.ts`](src/domain/document/tox.ts)<br>[`src/domain/engine/tox.ts`](src/domain/engine/tox.ts) | `main/sw/source/core/tox/tox.cxx`<br>`main/sw/inc/tox.hxx` | `SwTOXBase`, `SwTOXMark`, `TOX_CONTENT`, dynamic entry generation |
| **Margin Comments** | [`src/domain/document/comments.ts`](src/domain/document/comments.ts)<br>[`src/ui/editor/CommentBand.tsx`](src/ui/editor/CommentBand.tsx) | `main/sw/source/core/fields/postit.cxx`<br>`main/sw/source/ui/docvw/PostItMgr.cxx` | `SwPostItField`, `SwPostItMgr`, discussion threads and gutter balloons |
| **Track Changes** | [`src/domain/document/redline.ts`](src/domain/document/redline.ts) | `main/sw/source/core/doc/docredln.cxx`<br>`main/sw/inc/redline.hxx` | `SwRedline`, `SwRedlineTbl`, `REDLINE_ON` mode, accept and reject |
| **Bookmarks & Cross-references** | [`src/domain/document/bookmarks.ts`](src/domain/document/bookmarks.ts) | `main/sw/source/core/doc/docbm.cxx`<br>`main/sw/inc/bookmrk.hxx` | `SwBookmark`, `IDocumentMarkAccess`, scalar text anchors |
| **Floating Frames & Text Wrap** | [`src/domain/engine/flyLayout.ts`](src/domain/engine/flyLayout.ts)<br>[`src/ui/components/ImageWrapPicker.tsx`](src/ui/components/ImageWrapPicker.tsx) | `main/sw/source/core/layout/fly.cxx`<br>`main/sw/source/core/text/txtfly.cxx`<br>`main/sw/inc/fmtornt.hxx` | `SwFlyFrm`, `SwFlyFreeFrm`, `SwFmtSurround` (parallel, ideal, left, right, none, through), `SwTxtFly::GetSurroundForTextWrap`, `SwFmtHoriOrient`, `RES_OPAQUE` |
| **Hyphenation, Measurement & Lines** | [`src/domain/engine/lineBreak.ts`](src/domain/engine/lineBreak.ts)<br>[`src/domain/engine/measure.ts`](src/domain/engine/measure.ts) | `main/sw/source/core/text/txtfrm.cxx`<br>`main/sw/source/core/text/guess.cxx` | `SwTxtFormatter`, `SwLineLayout`, `SwTxtGuess::Guess`, inter-word justification |
| **Physical A4 Pagination** | [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts)<br>[`src/domain/document/pageSetup.ts`](src/domain/document/pageSetup.ts) | `main/sw/source/core/layout/layact.cxx`<br>`main/sw/source/core/layout/widorp.cxx` | `SwLayAction`, `WidowsAndOrphans`, `keepTogether`, `SwTabFrm::Split` |
| **Headers & Footers** | [`src/domain/document/pageFurniture.ts`](src/domain/document/pageFurniture.ts)<br>[`src/ui/components/FurnitureBand.tsx`](src/ui/components/FurnitureBand.tsx) | `main/sw/source/core/layout/headfrm.cxx`<br>`main/sw/source/core/fields/docufld.cxx` | `SwHeaderFrm`, `SwFooterFrm`, even/odd/first page distinction, variables |
| **Cursor & Selection** | [`src/domain/engine/cursor.ts`](src/domain/engine/cursor.ts) | `main/sw/source/core/crsr/pam.cxx`<br>`main/sw/source/core/crsr/swcrsr.cxx` | `SwPaM`, `SwPosition`, Unicode grapheme clusters, `stickyX` column memory |
| **Atomic Editing** | [`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/txtnode/ndtxt.cxx`<br>`main/sw/source/core/edit/editshell.cxx` | `SplitCntntNode`, `JoinNext`, `InsertText`, `EraseText`, `applyRunFormat` |
| **History & Undo** | [`src/domain/engine/history.ts`](src/domain/engine/history.ts) | `main/sw/source/core/undo/undobj.cxx`<br>`main/sw/source/core/undo/undoman.cxx` | `SwUndo`, `SwUndoManager`, smart grouping by character class |
| **Lists & Numbering** | [`src/domain/document/lists.ts`](src/domain/document/lists.ts) | `main/sw/source/core/doc/number.cxx`<br>`main/sw/inc/numrule.hxx` | `SwNumRule`, `SwNodeNum`, lists as paragraph attributes (`RES_PARATR_LIST_*`) |
| **Ruler & Indents** | [`src/ui/components/Ruler.tsx`](src/ui/components/Ruler.tsx)<br>[`src/ui/editor/useWriterInput.ts`](src/ui/editor/useWriterInput.ts) | `main/svx/source/dialog/svxruler.cxx`<br>`main/svx/source/items/svxitems.cxx` | `SvxRuler`, `SvxLRSpaceItem`, left/right and first-line indents |
| **Images & Cropping** | [`src/domain/document/images.ts`](src/domain/document/images.ts)<br>[`src/ui/dialogs/ImageCropper.tsx`](src/ui/dialogs/ImageCropper.tsx) | `main/sw/source/core/layout/flycnt.cxx`<br>`main/svx/source/items/grfatr.cxx` | `FLY_AS_CHAR`, `SwFlyCntFrm`, `SvxGrfCrop` (vector cropping with 4 insets) |
| **Math Formulas** | [`src/domain/math/render.ts`](src/domain/math/render.ts)<br>[`src/domain/math/snippets.ts`](src/domain/math/snippets.ts) | `main/starmath/source/document.cxx`<br>`main/starmath/source/parse.cxx` | StarMath (LaTeX/KaTeX rendered as inline and display vector SVG) |
| **Search & Regex** | [`src/domain/engine/search.ts`](src/domain/engine/search.ts)<br>[`src/ui/dialogs/FindReplacePanel.tsx`](src/ui/dialogs/FindReplacePanel.tsx) | `main/sw/source/core/edit/search.cxx` | `SwSearch`, `SwCursor::Find`, simultaneous highlighting and atomic replace |
| **ODF XML Deserialization** | [`src/domain/odf/import.ts`](src/domain/odf/import.ts)<br>[`src/domain/odf/styles.ts`](src/domain/odf/styles.ts) | `main/xmloff/source/text/txtimp.cxx`<br>`main/xmloff/source/text/XMLTableImport.cxx` | `XMLTextImportHelper`, parsing of `content.xml` and `styles.xml`, style resolution |
| **ODF XML Serialization** | [`src/domain/odf/export.ts`](src/domain/odf/export.ts)<br>[`src/domain/odf/styles.ts`](src/domain/odf/styles.ts) | `main/xmloff/source/text/txtparae.cxx`<br>`main/xmloff/source/text/XMLTableExport.cxx` | `XMLTextParagraphExport`, `AutomaticStyles` (optimal style deduplication) |
| **Native ODF ZIP Archive** | [`src/domain/odf/package.ts`](src/domain/odf/package.ts)<br>[`src/domain/odf/pictures.ts`](src/domain/odf/pictures.ts) | `main/xmloff/source/core/` | Native ZIP generation with no library (CRC32, `deflate-raw`, `Pictures/` folder) |
| **Vector PDF Generation** | [`src/domain/pdf/export.ts`](src/domain/pdf/export.ts)<br>[`src/domain/pdf/print.ts`](src/domain/pdf/print.ts) | `main/vcl/source/gdi/pdfwriter_impl.cxx` | Native PDF export with vectorized text, XObject images and formulas |
| **CRDT Synchronization** | [`src/domain/collab/crdt.ts`](src/domain/collab/crdt.ts)<br>[`src/domain/collab/session.ts`](src/domain/collab/session.ts) | `main/sw/source/core/txtnode/thints.cxx`<br>`main/sw/source/core/crsr/index.cxx` | `TextRun[]` ⇄ `Y.Text` bijection, `SwIndexReg` cursor adjustment |
| **Real-Time Server (Rust)** | [`server/src/main.rs`](server/src/main.rs)<br>[`server/src/sync.rs`](server/src/sync.rs)<br>[`server/src/doc.rs`](server/src/doc.rs) | `main/sw/source/ui/wrtsh/` | Binary Yjs WebSocket relay, persistent log, presence and snapshots |
| **Security & CloudServ JWT** | [`server/src/auth.rs`](server/src/auth.rs)<br>[`server/src/crypto.rs`](server/src/crypto.rs)<br>[`server/src/hook.rs`](server/src/hook.rs) | `main/sfx2/` | HS256 JWT verification, HMAC-SHA256 signing of CloudServ callbacks |

---

## 📐 Detailed Subsystem Description

### 1. Typesetting & Layout (`SwTxtFormatter`, `SwLineLayout`)
- **Pure line breaking**: Implemented in [`src/domain/engine/lineBreak.ts`](src/domain/engine/lineBreak.ts). Text is broken at whitespace break opportunities, overlong words are force-broken, and non-breaking spaces (`\u00a0`) are preserved.
- **Accurate justification**: Inter-word spacing (`wordSpacingPx`) is computed by spreading the remaining width across the line's spaces, without touching the last line of a paragraph.
- **Tab stops**: Computes regular (`tabStopPx`) or custom tab stops.

### 2. A4 Pagination & Widows/Orphans (`SwLayAction`, `WidowsAndOrphans`)
- **Real A4 printable area**: Computed in [`src/domain/document/pageSetup.ts`](src/domain/document/pageSetup.ts) (`pageWidthPx`, `pageHeightPx`, minus millimeter margins and header/footer bands).
- **Typographic break rules**: [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts) ensures that no paragraph leaves fewer than 2 orphan lines at the bottom of a page or fewer than 2 widow lines at the top of the next page.
- **Table splitting and header repetition**: Tables are split cleanly between two rows, and rows marked `isHeader` are automatically repeated at the top of each new page.

### 3. Footnotes (`SwFtnFrm` / `SwFtnContFrm`)
- **Automatic sequential numbering**: [`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) inserts superscripts (`¹`, `²`, etc.) whose metadata (`footnoteText`, `footnoteId`) is kept separate so it doesn't leak into text typed afterwards.
- **Space reservation & rendering**: [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts) and [`src/ui/editor/A4Page.tsx`](src/ui/editor/A4Page.tsx) dynamically reserve the required height at the bottom of the page and draw the typographic 20% horizontal separator rule.
- **ODF persistence**: Reading and writing conform to `<text:note text:note-class="footnote">` elements.

### 4. Dynamic Table of Contents (`SwTOXBase`)
- **Non-destructive collection**: [`src/domain/document/tox.ts`](src/domain/document/tox.ts) and [`src/domain/engine/tox.ts`](src/domain/engine/tox.ts) scan the document's headings (`Heading 1-6`) without freezing the text, recomputing page numbers on every pagination pass.
- **Layout with dot leaders**: TOC entries are rendered with hierarchical indentation, dot leaders (`. . . . .`) and clickable links (`__RefHeading__`).

### 5. Margin Comments & Track Changes (`SwPostItField`, `SwRedline`)
- **Annotation balloons**: [`src/domain/document/comments.ts`](src/domain/document/comments.ts) and [`src/ui/editor/CommentBand.tsx`](src/ui/editor/CommentBand.tsx) place comments in the right margin of the A4 sheet, visually linked to the commented text range.
- **Revision mode (`REDLINE_ON`)**: [`src/domain/document/redline.ts`](src/domain/document/redline.ts) records insertions (`REDLINE_INSERT`) and deletions (`REDLINE_DELETE`) with author, date and a dedicated author color (`REDLINE_AUTHOR_COLORS`). Changes can be accepted or rejected one at a time or all at once.

### 6. Floating Frames & Text Wrap (`SwFlyFrm`, `SwSurround`)
- **Geometric interval subtraction**: [`src/domain/engine/flyLayout.ts`](src/domain/engine/flyLayout.ts) computes the usable band left for each line of text cut by a floating frame, following OpenOffice's wrap modes (*Parallel*, *Left*, *Right*, *None*, *Through*).
- **Optimal wrap (`SURROUND_IDEAL`)**: A port of `SwTxtFly::GetSurroundForTextWrap` (`txtfly.cxx:2372`). This mode doesn't describe a geometry; it describes a **decision**. The space left on each side of the frame decides, using the C++ thresholds: `TEXT_MIN` (2 cm), below which a column isn't worth creating, and `FRAME_MAX` (1.5 cm), above which the frame keeps only its wider side.
- **Declared, not fixed, position (`SwFmtHoriOrient`)**: A frame carries an **alignment** (left, center, right, or free position) and a **reference** (text column or whole page), resolved to an x-coordinate on every layout pass. An image aligned to the right margin stays there when the margin changes; a fixed x-coordinate in points would not.
- **Two layers (`RES_OPAQUE`)**: "Behind text" and "In front of text" share the `through` wrap mode and the same geometry. Only the paint order differs, just as `SwRootFrm::Paint` paints `hell` before the text and `heaven` after it. PDF export uses the same order.
- **Overflow beyond the anchor**: `SwTxtFly` queries the frame list of the **page**, not that of the anchor paragraph. `projectedExclusions` does the same, so an image that extends past its paragraph (the common case) also pushes aside the text of the following paragraphs. Because its absolute position comes from an earlier pass, pagination runs a second pass whenever a frame is present.
- **User choice**: [`src/ui/components/ImageWrapPicker.tsx`](src/ui/components/ImageWrapPicker.tsx) combines OpenOffice's three attributes (anchoring, wrap, layer) into the five useful combinations of the "Format ▸ Wrap" menu: *Inline*, *Wrap*, *Interleave text*, *Behind text*, *In front of text*. The menu is available on the selected image's toolbar and in the image workshop.
- **Dragging and re-anchoring (`SwFEShell::BeginDrag` / `SetAnchor`)**: **Any** image can be grabbed with the mouse, whether it is a floating frame or an inline image. On release, [`moveImageRun`](src/domain/engine/edit.ts) re-anchors the frame to the paragraph where it was dropped. The anchor decides which page it's on, so updating it is what lets you drop an image onto another page. A floating frame gains free coordinates (`HoriOrientation::NONE`); an inline image simply moves to a new position in the text.

---

### 7. Dialog Windows (`Modal`, `SwFrmDlg`)

- **One column, three zones**: [`src/design/components/Modal.tsx`](src/design/components/Modal.tsx) pins the header and the action bar, and only the body scrolls. When the whole window scrolled, "Apply" slid below the edge of the screen, and the dialog looked like it had no way out.
- **Width is requested, never enforced**: `width` becomes `min(width, 100%)`. A hard-coded width overflowed narrow screens and required a **horizontal** scrollbar to reach half the fields, which is the most costly flaw a form can have.
- **Image workshop tabs**: The split follows `SwFrmDlg`: *Image* (source, dimensions, alt text), *Position* (wrap, alignment, offsets), *Caption*. Twenty flat settings all looked equally important; three pages of six can be scanned at a glance. The preview stays visible because it is what all three pages are about. The tab bar is fully ARIA-compliant: one tab stop for the bar, with arrow keys to move between tabs.
- **Mobile (≤ 767 px)**: The window goes full screen, the preview moves above the settings, the five wrap modes are laid out in two columns, and every touch target is at least 44 px (WCAG 2.5.8). Notches are respected (`env(safe-area-inset-*)`).

## 🔒 Secure Integration with CloudServ

Writer integrates with **CloudServ** as a temporary, stateless editor, following this principle:
> **"The application edits. CloudServ owns."**

```text
   ┌───────────────────────┐   Service ticket (JWT HS256, 60s)     ┌──────────────────────────┐
   │                       │ ────────────────────────────────────▶ │                          │
   │       CloudServ       │   POST /api/v1/documents              │   Writer Server (Rust)   │
   │     (Python API)      │                                       │   (Port 8081)            │
   │                       │ ◀──────────────────────────────────── │                          │
   └───────────────────────┘   HMAC-SHA256 signed body             └──────────────────────────┘
                               POST …/session-checkpoint (during session)
                               POST …/session-closed     (at the end)
```

1. **Per-user JWT tickets**: Issued by CloudServ (`WRITER_JWT_SECRET`) and verified by [`server/src/auth.rs`](server/src/auth.rs), which strictly checks `alg: HS256`, enforces a short 900s expiration and requires the ticket to match the document ID.
2. **Periodic offloading (`session-checkpoint`)**: Sent by [`server/src/hook.rs`](server/src/hook.rs) after 10s of inactivity or every 120s at most, saving the state to the Drive without flooding the version history.
3. **Secure close (`session-closed`)**: Triggered once the last user has left and a 30s grace period has passed. The HMAC-SHA256 signed callback archives a version in `.versions/` and purges temporary local data.

---

## 🧪 Test Suites & Validation

Writer's reliability is backed by **27 automated test suites** on the client and **100 unit tests** on the server:

### Vitest Client Tests (`test/*.test.ts`): 504 tests (100% passing)
- [`test/runs.test.ts`](test/runs.test.ts): 20 tests on `SwpHints::MergePortions` and style range normalization.
- [`test/lineBreak.test.ts`](test/lineBreak.test.ts): 15 tests on `SwTxtFormatter` (hyphenation, justification, tabs).
- [`test/paginate.test.ts`](test/paginate.test.ts): 15 tests on `SwLayAction` (A4 pagination, widows, orphans, tables).
- [`test/footnote.test.ts`](test/footnote.test.ts) & [`test/footnoteReserve.test.ts`](test/footnoteReserve.test.ts): 13 tests on `SwFtnFrm` and footnote space reservation.
- [`test/tableMutation.test.ts`](test/tableMutation.test.ts) & [`test/cellMerge.test.ts`](test/cellMerge.test.ts): 20 tests on table mutations and cell merging.
- [`test/tox.test.ts`](test/tox.test.ts): 20 tests on the `SwTOXBase` table of contents.
- [`test/annotations.test.ts`](test/annotations.test.ts): 25 tests on `SwPostItField` comments.
- [`test/redline.test.ts`](test/redline.test.ts): 21 tests on `SwRedline` change tracking.
- [`test/flyLayout.test.ts`](test/flyLayout.test.ts): 56 tests on floating frames, text wrap (including `SURROUND_IDEAL`), alignment and layers.
- [`test/odf.test.ts`](test/odf.test.ts): 29 tests on native ODF 1.2 import/export (`xmloff`).
- [`test/images.test.ts`](test/images.test.ts): 48 tests on `FLY_AS_CHAR`, `SvxGrfCrop` cropping and frame moving (`SwFEShell::SetAnchor`).
- [`test/collab.test.ts`](test/collab.test.ts): 35 tests on Yjs CRDT synchronization.
- [`test/search.test.ts`](test/search.test.ts): 20 tests on the `SwSearch` regex search engine.
- [`test/lists.test.ts`](test/lists.test.ts): 22 tests on `SwNumRule` hierarchical numbering.
- [`test/math.test.ts`](test/math.test.ts): 17 tests on vector math formulas.
- [`test/pdf.test.ts`](test/pdf.test.ts): 8 tests on vector PDF export.
- [`test/pageFurniture.test.ts`](test/pageFurniture.test.ts): 6 tests on headers/footers and variables.
- [`test/edit.test.ts`](test/edit.test.ts): 26 tests on atomic editing operations and `SwUndo`.
- [`test/cloudserv.test.ts`](test/cloudserv.test.ts): 8 tests on JWT ticket authentication and sessions.
- [`test/lectureSeule.test.ts`](test/lectureSeule.test.ts): 4 tests on permissions and read-only mode.
- [`test/exemple.test.ts`](test/exemple.test.ts): 20 tests validating the complete demo document.

### Rust Server Tests (`server/src/`): 100 tests (100% passing)
- Cryptographic validation (SHA-256 FIPS 180-4, HMAC RFC 4231, constant-time comparison).
- Yrs CRDT convergence, log compaction, restore point rotation and binary packet parsing.
- JWT ticket verification and `session-checkpoint` / `session-closed` HTTP callbacks.
