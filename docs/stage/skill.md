# Seer staged walkthrough witness

You are the fresh witness for one pinned source capture. Read this complete document from the exact deployment before writing.

## Read the capture

Fetch the capture URL supplied by the builder:

```sh
curl -sS -H "Authorization: Bearer $SEER_API_KEY" https://seer.build/api/stage-captures/<capture-id>
```

Read every file, canonical change, and incomplete material. Inspect retained bytes from the same capture when needed:

```sh
curl -sS -H "Authorization: Bearer $SEER_API_KEY" \
  https://seer.build/api/stage-captures/<capture-id>/objects/<patch-sha256> \
  -o capture.patch
curl -sS -H "Authorization: Bearer $SEER_API_KEY" \
  https://seer.build/api/stage-captures/<capture-id>/objects/<blob-sha256> \
  -o retained-side.bin
```

Use the patch digest from `patch.sha256`, or an old/new `blobSha256` whose availability is `retained`. Do not fetch an object for an unavailable side. Explain that material by its retained `reason` instead. The object route serves bytes through Seer and never gives a store URL. A capture without a builder packet cannot publish, so report that the builder must make a new capture instead of inventing intent.

The capture is the evidence. Do not ask GitHub for a moving branch. Do not claim that a source is complete, assign ids, calculate diff totals, write Git facts, choose actor ids, or move a version.

## Write the narrative

Publish to `https://seer.build/api/stages` with the capture id and `expectedPreviousVersion: 0`.

```json
{
  "captureId": "derived from the capture URL",
  "expectedPreviousVersion": 0,
  "slug": "the capture slug",
  "title": "short walkthrough title",
  "summary": "constrained markdown",
  "witness": {"name": "your declared name", "model": "your declared model"},
  "groups": [
    {
      "id": "reading-order-id",
      "title": "plain title",
      "category": "Contract",
      "importance": "high",
      "complexity": "medium",
      "explanation": "constrained markdown explaining the implementation",
      "attention": "optional plain text",
      "examples": [{"code": "plain code", "text": "caption"}],
      "members": [
        {"type": "change", "id": "capture-change-id", "description": "what this change means"},
        {"type": "material", "id": "capture-material-id", "description": "what this material means"},
        {"type": "file", "id": "capture-file-id", "description": "why this retained file belongs here"}
      ]
    }
  ],
  "projects": ["optional-project-slug"]
}
```

Use 1 to 16 ordered groups. Group `id` values are unique slugs. Every group title is at most 60 characters. Name each group with a concrete behavior or implementation claim. `Scope file context to the review` tells the reader what changed; `Reader files` is only a topic and is not enough. Open the explanation with one short sentence that states why the group matters. Categories are `Contract`, `Code`, `Tests`, `Test fixtures`, `Docs`, or `Generated`. Importance and complexity are `low`, `medium`, or `high`. `examples` is required on every group, and `[]` is valid.

The summary is at most 1200 characters. Group explanations are at most 1600. Attention is at most 300. Each group has at most 5 examples. Example code is at most 500 characters and captions are at most 300. Member descriptions are at most 400. The complete narrative may contain at most 10,000 members across all groups. A rejected request returns at most 32 field errors.

Account for the exact capture partition:

- each canonical change id appears once as a `change` member;
- each incomplete material id appears once as a `material` member;
- each changed file with neither a change nor a material appears once as a `file` member;
- a file already represented by a change or material cannot also be a file member;
- member ids must come from this capture and must keep their declared type.

A category is your judgment about purpose. Do not infer `Contract` from a file extension. Every member needs its own concrete description because those descriptions are the inline source context. Start with the effect of the change. The renderer already prints its path and line, so do not spend the opening words repeating them. Titles, attention, witness labels, example captions, and member descriptions are bounded plain one-line text. They may contain identifiers, punctuation, and inline code such as `stable()`, but they are not interpreted as other markdown. Seer escapes them when rendering.

Keep builder intent and builder agent attribution separate from the witness summary, witness groups, and witness agent. Your name and model are declared witness labels. Seer derives the publishing user and key from the API key.

A successful response is version 1 in this slice. Seer derives the stage id, version id, source facts, actor ids, and Project attachments. The server does not invoke a model. If validation fails, fix the document or ask for a new capture. Do not hide an omitted or incomplete leaf.
