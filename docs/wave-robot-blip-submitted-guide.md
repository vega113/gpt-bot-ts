# How Wave Robots Detect "Blip Submitted" and Reply to Users

## The Problem

Wave robots need to know when a user has **finished editing** a blip before responding. Responding mid-edit would be disruptive and produce replies to incomplete messages.

The legacy `BLIP_SUBMITTED` event is deprecated. The modern approach uses `user/d/` annotations on the document, but the mechanism is non-obvious and requires understanding several layers of the Wave protocol.

## The Mechanism: `user/d/{sessionId}` Annotations

### How Editing State Works

When a user edits a blip, Wave's collaborative editor writes **persistent annotations** to the document. These annotations are real ops sent to the server and visible to all participants (including robots).

The key annotation is `user/d/{sessionId}`, where `{sessionId}` is a unique identifier per browser tab/session.

### Annotation Value Format

The value is a comma-separated string with 3 fields:

```
"{userId},{startTimeMs},{endTimeMs}"
```

| State | Value | Example |
|-------|-------|---------|
| **Editing in progress** | End timestamp is **empty** | `"vega@supawave.ai,1775485999253,"` |
| **Editing complete** | End timestamp is **present** | `"vega@supawave.ai,1775485999253,1775486001215"` |

The annotation is **permanent** — it is never removed from the blip. Only the end timestamp being filled in signals that editing is done.

### When Does the End Timestamp Get Set?

The end timestamp is filled in when:
- The user presses **Shift+Enter** (explicit submit)
- The user **clicks away** from the blip (loses focus)
- The user **closes the editor** or navigates away

### Which Events Fire?

This is a critical detail. The Wave `EventGenerator.java` has separate code paths:

```
Annotation ops  →  ANNOTATED_TEXT_CHANGED event
Content ops     →  DOCUMENT_CHANGED event
```

These are in mutually exclusive `if/else` branches. An annotation change (like filling in the end timestamp) **only** fires `ANNOTATED_TEXT_CHANGED`, **never** `DOCUMENT_CHANGED`.

Therefore, robots must subscribe to **both** event types:

```xml
<w:capabilities>
  <w:capability name="DOCUMENT_CHANGED" context="SELF"/>
  <w:capability name="ANNOTATED_TEXT_CHANGED" context="SELF"/>
</w:capabilities>
```

## Complete Detection Algorithm

```
On receiving an event bundle:

1. For each event of type DOCUMENT_CHANGED or ANNOTATED_TEXT_CHANGED:
   a. Get the blipId from event.properties.blipId
   b. Look up the blip data in bundle.blips[blipId]
   c. Find all annotations where name starts with "user/d/"

2. For each user/d/ annotation, parse the value:
   - Split by comma: [userId, startTimeMs, endTimeMs]
   - If endTimeMs is EMPTY or MISSING → user is still editing → SKIP
   - If endTimeMs is PRESENT (non-empty) → this editing session is done

3. If ANY user/d/ annotation has an empty endTimeMs → blip is still
   being edited (possibly by a different user) → do NOT respond yet

4. If ALL user/d/ annotations have endTimeMs filled in → editing is
   complete → safe to respond

5. Deduplicate: track (blipId → lastRespondedContent) to avoid
   responding to the same content multiple times, since multiple
   events may arrive after editing stops
```

### TypeScript Example

```typescript
interface Annotation {
  name: string;
  value: string;
  range: { start: number; end: number };
}

interface BlipData {
  blipId: string;
  content: string;
  annotations?: Annotation[];
}

/**
 * Returns true if any user is still actively editing this blip.
 */
function isBeingEdited(blip: BlipData): boolean {
  if (!blip.annotations) return false;
  return blip.annotations.some((a) => {
    if (!a.name.startsWith('user/d/')) return false;
    if (a.value == null || a.value === '') return false;
    const parts = a.value.split(',');
    // parts[2] is endTimeMs — empty or missing means still editing
    return parts.length < 3 || parts[2] === '';
  });
}
```

### How to Reply

Robots reply by posting a new blip via the Data API:

```json
{
  "id": "op-1",
  "method": "wavelet.appendBlip",
  "params": {
    "waveId": "supawave.ai!w+abc123",
    "waveletId": "supawave.ai!conv+root",
    "blipData": {
      "blipId": "TBD_reply_1",
      "content": "\nHello! Here is my response."
    }
  }
}
```

Important: blip content **must** start with `\n`.

### Async Reply Pattern

Because AI processing takes time, robots should:

1. **Respond immediately** to the callback with `robot.notify` (acknowledges the event)
2. **Process asynchronously** (run AI agent, web search, etc.)
3. **Post reply via Data API** using `wavelet.appendBlip`

This prevents the Wave server's HTTP callback from timing out.

## Common Pitfalls

| Pitfall | Why It's Wrong |
|---------|---------------|
| Checking if `user/d/` annotation **exists** | Annotations are permanent — they're never removed. Existence tells you nothing. |
| Only subscribing to `DOCUMENT_CHANGED` | Annotation changes (editing stop signal) fire `ANNOTATED_TEXT_CHANGED`, not `DOCUMENT_CHANGED`. You'll miss the "done" signal. |
| Using `BLIP_SUBMITTED` event | Deprecated. Will not fire in newer versions. |
| Checking annotation **presence/absence** | The signal is in the **value** (empty vs non-empty end timestamp), not in whether the annotation exists. |
| Not deduplicating | `DOCUMENT_CHANGED` fires on every keystroke. Without dedup you'll respond to partial input or respond multiple times. |

---

## Recommendations for Improving Developer Experience

### 1. Add a `BLIP_EDITING_DONE` Synthetic Event

**The biggest improvement possible.** The current mechanism requires developers to:
- Know about `user/d/` annotations (undocumented tribal knowledge)
- Parse a comma-separated string with positional fields
- Subscribe to two different event types
- Understand the EventGenerator's if/else branching behavior
- Implement deduplication

Instead, the Wave server could synthesize a high-level `BLIP_EDITING_DONE` event when it detects all `user/d/` annotations on a blip have their end timestamps filled in. This event would include the blipId, the final content, and the last editor.

```xml
<w:capability name="BLIP_EDITING_DONE" context="SELF"/>
```

This is a one-line subscription, zero parsing, zero edge cases.

**Implementation sketch:** In `EventGenerator.java`, when processing an `ANNOTATION_CHANGED` for a `user/d/` key where the new value has a non-empty end timestamp, check if all other `user/d/` annotations on that blip also have end timestamps. If yes, emit `BLIP_EDITING_DONE`.

### 2. Update API Documentation (`/api-docs`)

The current docs likely don't explain:
- That `BLIP_SUBMITTED` is deprecated and what replaces it
- The `user/d/` annotation value format (`userId,startMs,endMs`)
- That `ANNOTATED_TEXT_CHANGED` is required alongside `DOCUMENT_CHANGED`
- The deduplication requirement

**Suggested new section: "Detecting Editing Completion"** with the algorithm above and code examples in Python, Java, and TypeScript.

### 3. Update LLM Onboarding Prompt (`/llms-full.txt`)

The LLM-facing documentation should include a concise version of this guide so that AI coding assistants (Claude, GPT, Copilot) can correctly implement Wave robots without trial and error. Key content:

```markdown
## Robot Event Handling: Detecting Blip Submission

BLIP_SUBMITTED is DEPRECATED. To detect when a user finishes editing:

1. Subscribe to DOCUMENT_CHANGED and ANNOTATED_TEXT_CHANGED
2. Check user/d/{sessionId} annotation values on the blip:
   - "userId,startMs," (empty end) = still editing
   - "userId,startMs,endMs" (end present) = done editing
3. Respond only when ALL user/d/ annotations have non-empty end timestamps
4. Deduplicate by tracking (blipId, content) pairs

Reply via wavelet.appendBlip through the Data API (async pattern recommended).
```

### 4. Add Helper to the Robot SDK / Example Bot

If SupaWave provides a robot SDK or example bots, add a utility function:

```java
public static boolean isEditingComplete(Blip blip) {
    for (Annotation ann : blip.getAnnotations("user/d/")) {
        String[] parts = ann.getValue().split(",", 3);
        if (parts.length < 3 || parts[2].isEmpty()) {
            return false; // still editing
        }
    }
    return true;
}
```

This encapsulates the tribal knowledge into a single function call.

### 5. Consider Making `DOCUMENT_CHANGED` Fire for Annotation Ops Too

The current `EventGenerator.java` uses `if/else` branching that separates annotation changes from content changes. This forces robots to subscribe to two events for what is logically one use case. If `DOCUMENT_CHANGED` also fired for annotation changes (or at least for `user/d/` annotation changes), robots could use a single subscription.

**Trade-off:** This would increase event volume for robots that don't care about annotations. A flag like `context="SELF,INCLUDE_ANNOTATIONS"` could make it opt-in.

### Summary of Priorities

| Priority | Improvement | Effort | Impact |
|----------|------------|--------|--------|
| **P0** | Update `/llms-full.txt` with editing detection guide | Low | High — AI assistants will generate correct robot code |
| **P0** | Update `/api-docs` with "Detecting Editing Completion" section | Low | High — developers can find the info |
| **P1** | Add `BLIP_EDITING_DONE` synthetic event | Medium | Very High — eliminates all complexity |
| **P2** | Add `isEditingComplete()` helper to example bots | Low | Medium — encapsulates the logic |
| **P3** | Consider firing `DOCUMENT_CHANGED` for annotation ops | Medium | Medium — simplifies subscriptions |
