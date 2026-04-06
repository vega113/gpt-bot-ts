# AI Agent Prompt: Wave Robot Editing Detection & Reply

> This prompt is for AI coding assistants (Claude, GPT, Copilot) helping developers
> build SupaWave/Wave robots. Include this in `/llms-full.txt`, CLAUDE.md, or
> equivalent onboarding context.

---

## Prompt Content

### How Wave Robots Detect When a User Finishes Editing a Blip

**CRITICAL: `BLIP_SUBMITTED` is removed. Do NOT use it.** The `SubmitBlip` operation was
converted to a no-op in the core Wave protocol by Google's original team before open-sourcing.
The `EventGenerator` never generates this event. Any robot subscribing to `BLIP_SUBMITTED`
will never receive it.

#### The Editing Lifecycle

Wave is a real-time collaborative editor. There is no "submit" action — text appears
character-by-character as users type. Instead, editing state is tracked via **persistent
annotations** on the document:

1. **User starts editing** a blip → Wave client writes `user/d/{sessionId}` annotation
   with value `"{userId},{startTimeMs},"` (empty end timestamp)
2. **User is typing** → content changes fire `DOCUMENT_CHANGED` events;
   the `user/d/` annotation still has an empty end timestamp
3. **User finishes editing** (Shift+Enter, click away, close editor) →
   Wave client updates the annotation value to `"{userId},{startTimeMs},{endTimeMs}"`
   (end timestamp filled in). This fires `ANNOTATED_TEXT_CHANGED`.

#### Annotation Value Format

```
"userId,startTimeMs,endTimeMs"
```

| State | Value | How to detect |
|-------|-------|---------------|
| Still editing | `"vega@supawave.ai,1775485999253,"` | Split by `,` → 3rd field is empty |
| Done editing | `"vega@supawave.ai,1775485999253,1775486001215"` | Split by `,` → 3rd field is non-empty |

**The annotation is permanent.** It is never removed from the blip. Only the end
timestamp being filled in signals completion. Do NOT check for annotation
presence/absence — check the VALUE.

#### Required Event Subscriptions

You MUST subscribe to BOTH event types:

```xml
<w:capabilities>
  <w:capability name="DOCUMENT_CHANGED" context="SELF"/>
  <w:capability name="ANNOTATED_TEXT_CHANGED" context="SELF"/>
</w:capabilities>
```

**Why both?** The `EventGenerator.java` has mutually exclusive code paths:
- `ANNOTATION_CHANGED` document ops → generates `ANNOTATED_TEXT_CHANGED` only
- Content/attribute document ops → generates `DOCUMENT_CHANGED` only

The "editing done" signal (end timestamp filled in) is an annotation change, so it
ONLY fires `ANNOTATED_TEXT_CHANGED`. Without subscribing to it, the robot will
never know editing finished.

#### Detection Algorithm

```
function isBeingEdited(blip):
  for each annotation on blip:
    if annotation.name starts with "user/d/":
      parts = annotation.value.split(",")
      if parts.length < 3 OR parts[2] is empty:
        return true   // this user is still editing
  return false        // no active editing sessions

function shouldProcessBlip(blip, alreadyRespondedMap):
  if isBeingEdited(blip):
    return false      // wait for editing to finish
  content = blip.content.trim()
  if content == alreadyRespondedMap.get(blip.blipId):
    return false      // already responded to this version
  return true
```

#### Reply Pattern for AI Bots

AI processing takes seconds. To avoid callback timeout:

1. **Respond immediately** to the callback POST with `robot.notify` acknowledgment
2. **Process asynchronously** (run AI model, web search, etc.)
3. **Post reply via Data API** using `wavelet.appendBlip` (content must start with `\n`)

```
POST /robot/dataapi/rpc
Authorization: Bearer {token}

[{
  "id": "reply-1",
  "method": "wavelet.appendBlip",
  "params": {
    "waveId": "supawave.ai!w+abc123",
    "waveletId": "supawave.ai!conv+root",
    "blipData": {
      "blipId": "TBD_reply_1",
      "content": "\nYour reply text here"
    }
  }
}]
```

#### Common Mistakes

- ❌ Using `BLIP_SUBMITTED` — removed, EventGenerator never generates it
- ❌ Checking if `user/d/` annotation exists — annotations are permanent, never removed
- ❌ Only subscribing to `DOCUMENT_CHANGED` — misses the "editing done" annotation change
- ❌ Treating annotation value as `"address,timestamp,compositionState"` — the format is `"userId,startTimeMs,endTimeMs"`
- ❌ Responding synchronously in callback — will timeout for AI bots, use async + Data API

---

## Recommendations for SupaWave Platform

### Problem Statement

The current mechanism for detecting "blip submitted" requires robot developers to:
1. Know about `user/d/` annotations (undocumented, tribal knowledge)
2. Parse a comma-separated string with positional fields
3. Subscribe to TWO event types and understand why
4. Read `EventGenerator.java` source to understand the `if/else` branching
5. Implement content deduplication
6. Handle the async reply pattern

This is a **P0 developer experience problem**. Every robot author will get this wrong
on their first attempt. AI coding assistants will also get it wrong without explicit
context (as demonstrated during the development of gpt-bot-ts).

### Option A: Synthesize `BLIP_EDITING_DONE` Event in EventGenerator (Recommended)

**Effort: Medium | Impact: Very High**

Add a new event type that the `EventGenerator` synthesizes when it detects all
`user/d/` annotations on a blip have their end timestamps filled in.

```java
// In EventGenerator.EventGeneratingDocumentHandler.onDocumentEvents():
if (eventComponent.getType() == DocumentEvent.Type.ANNOTATION_CHANGED) {
    AnnotationChanged<N, E, T> annChanged = (AnnotationChanged<N, E, T>) eventComponent;

    // Check if this is a user/d/ annotation getting its end timestamp
    if (annChanged.key.startsWith("user/d/") && annChanged.newValue != null) {
        String[] parts = annChanged.newValue.split(",", 3);
        if (parts.length == 3 && !parts[2].isEmpty()) {
            // End timestamp was just filled in — check if ALL user/d/ are done
            if (allEditingSessionsClosed(blip)) {
                BlipEditingDoneEvent event = new BlipEditingDoneEvent(
                    null, null, deltaAuthor.getAddress(), deltaTimestamp,
                    blip.getId(), parts[0] /* last editor */);
                addEvent(event, capabilities, blip.getId(), messages);
            }
        }
    }
    // ... existing ANNOTATED_TEXT_CHANGED logic
}
```

Robot developers would then simply:
```xml
<w:capability name="BLIP_EDITING_DONE" context="SELF"/>
```
```java
@Override
public void onBlipEditingDone(BlipEditingDoneEvent event) {
    String content = event.getBlip().getContent();
    event.getBlip().getWavelet().reply("\n" + generateReply(content));
}
```

**Pros:**
- One event subscription, zero parsing, zero dedup needed
- Works with existing `AbstractRobot` pattern
- Clear semantics — no annotation knowledge needed
- Can be implemented without breaking existing robots

**Cons:**
- New event type to maintain
- Edge case: multi-user editing (need "all sessions closed" check)

### Option B: Add `isEditingComplete()` to Java Robot SDK (Quick Win)

**Effort: Low | Impact: Medium**

Add a helper method to `AbstractRobot` or `Blip`:

```java
// In com.google.wave.api.Blip
public boolean isEditingComplete() {
    for (Annotation ann : getAnnotations()) {
        if (ann.getName().startsWith("user/d/")) {
            String[] parts = ann.getValue().split(",", 3);
            if (parts.length < 3 || parts[2].isEmpty()) {
                return false;
            }
        }
    }
    return true;
}
```

Robot developers subscribe to both events but get a simple boolean check:
```java
@Override
public void onDocumentChanged(DocumentChangedEvent event) {
    if (event.getBlip().isEditingComplete()) {
        // safe to respond
    }
}

@Override
public void onAnnotatedTextChanged(AnnotatedTextChangedEvent event) {
    if (event.getBlip().isEditingComplete()) {
        // safe to respond
    }
}
```

**Pros:** Minimal server change, encapsulates parsing logic
**Cons:** Still requires two subscriptions, still requires dedup

### Option C: Re-implement `BLIP_SUBMITTED` with New Semantics

**Effort: Medium | Impact: High**

Instead of creating a new event name, re-purpose the existing `BLIP_SUBMITTED`
with the new annotation-based semantics. The `EventGenerator` would generate it
when editing completes (same logic as Option A, but using the existing event type).

**Pros:**
- Zero API surface change — existing robots that subscribe to BLIP_SUBMITTED
  would start working again
- All documentation, examples, and tutorials that mention BLIP_SUBMITTED remain valid
- Echoey and other examples could use it directly

**Cons:**
- Semantic confusion — "submitted" implies explicit action, but now it means
  "user stopped editing"
- Google intentionally removed it; re-adding might create confusion about Wave protocol versions

### Option D: Create TypeScript/Python Robot SDKs with Built-in Handling

**Effort: High | Impact: High (for external ecosystem)**

Currently there's only the Java SDK (`AbstractRobot`). For the TypeScript/Python
ecosystem, create lightweight SDKs that handle the annotation parsing internally:

```typescript
// @supawave/robot-sdk (hypothetical)
import { WaveRobot } from '@supawave/robot-sdk';

const bot = new WaveRobot({
  address: 'my-bot@supawave.ai',
  callbackUrl: 'https://my-bot.supawave.ai',
});

// Single callback — SDK handles annotation detection + dedup internally
bot.onBlipReady((event) => {
  const { blip, author, waveId } = event;
  const reply = await generateReply(blip.content);
  await event.reply(reply); // SDK handles appendBlip via Data API
});

bot.listen(8089);
```

**Pros:** Best DX for non-Java developers, hides all complexity
**Cons:** Multiple SDKs to maintain, significant effort

### Option E: Handle in `DOCUMENT_CHANGED` Too (Server-Side Fix)

**Effort: Low | Impact: Medium**

Modify `EventGenerator.java` to also fire `DOCUMENT_CHANGED` for annotation ops
(remove the `if/else` exclusion), or at least for `user/d/` annotation changes.

This way robots only need ONE subscription (`DOCUMENT_CHANGED`) and the annotation
check in the blip data.

**Cons:** Increases event volume; changes long-standing EventGenerator behavior

### Recommended Approach (Phased)

| Phase | Action | Effort | Timeline |
|-------|--------|--------|----------|
| **Phase 1** | Update `/llms-full.txt` and `/api-docs` with this prompt content | Low | Immediate |
| **Phase 2** | Add `Blip.isEditingComplete()` to Java SDK (Option B) | Low | 1-2 days |
| **Phase 3** | Implement `BLIP_EDITING_DONE` synthetic event (Option A) | Medium | 1 week |
| **Phase 4** | Create `@supawave/robot-sdk` for TypeScript (Option D) | High | 2-4 weeks |

Phase 1 unblocks AI agents immediately. Phase 2 gives Java robot developers a
quick win. Phase 3 is the definitive solution. Phase 4 grows the ecosystem.

### What to Do with Existing `BLIP_SUBMITTED`

**Remove it completely:**

1. Remove `BlipSubmittedEvent.java` class
2. Remove `BLIP_SUBMITTED` from `EventType` enum
3. Remove `onBlipSubmitted()` from `AbstractRobot`
4. Remove from `Echoey` and other example robots
5. Add deprecation note in changelog
6. Update capabilities XML parser to log a warning if a robot subscribes to it

**OR keep as alias:** Have `BLIP_SUBMITTED` in capabilities map to `BLIP_EDITING_DONE`
logic internally, so old robots work without changes. Add a log warning suggesting
migration.

### Documentation Updates Needed

1. **`/llms-full.txt`** — Add the "Prompt Content" section above verbatim
2. **`/api-docs`** — New section "Detecting Editing Completion" with algorithm + code
3. **Robot registration page** — Link to editing detection docs
4. **Example robots** — Update Echoey and gpt-bot to use new pattern
5. **Changelog** — Document BLIP_SUBMITTED removal and migration path
6. **capabilities.xml** reference — List ANNOTATED_TEXT_CHANGED as required for bots
   that need to detect editing completion
