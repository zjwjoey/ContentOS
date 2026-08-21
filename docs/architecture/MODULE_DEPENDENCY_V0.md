# Module Dependency V0

## Allowed dependencies

```text
Project  <- Director, Asset, Video, Publisher, Review, Job
Asset    <- Director, Video, Publisher, Review
Job      <- Director, Video, Publisher, Review
AI       <- Director, Review
Video    <- API orchestration only; Video Worker uses its worker contract
Publisher<- API orchestration only; Publisher Worker uses adapter contracts
```

Modules depend on another module’s published application contract or read model, never its repository implementation or tables. Infrastructure interfaces live in Core contracts; concrete adapters are wired at process composition roots.

## Dependency rules

1. **RULE-D001:** Publisher must not import Video implementation; it accepts a rendered Asset/Render ID.
2. **RULE-D002:** Director must not import Publisher; Director creates script/storyboard facts only.
3. **RULE-D003:** Workers must not call Web UI code or HTTP controllers.
4. **RULE-D004:** A module must not query another module’s owned tables to create coupling.
5. **RULE-D005:** Core may define contracts and bootstrap modules, but contains no Director/Video/Publisher business rules.
6. **RULE-D006:** Asset is the only module that resolves storage locators for business modules.
7. **RULE-D007:** Video owns VideoPlan/EditManifest/Render; no other module writes them.
8. **RULE-D008:** Publisher owns Account/PublishRequest/PublishAttempt; no other module writes them.
9. **RULE-D009:** Job owns Job, dependency, lease and attempt transitions; workers request transitions via Job contract.
10. **RULE-D010:** AI owns provider credentials/model profiles/prompt versions/AI runs; Director never imports a vendor SDK.
11. **RULE-D011:** Review consumes normalized metric snapshots; it does not scrape platforms.
12. **RULE-D012:** API controllers call module use cases, never repositories directly.
13. **RULE-D013:** Adapter keys and model-provider keys are values, not conditionals spread across modules.
14. **RULE-D014:** Cross-module events are post-commit domain events/outbox records, not synchronous hidden callbacks.
15. **RULE-D015:** Shared types must be small, stable contracts; `shared` must not become a miscellaneous domain bucket.
16. **RULE-D016:** Worker input is a versioned contract plus IDs, never an unvalidated UI payload.
17. **RULE-D017:** Deletion/retention is coordinated through owning modules; no worker permanently deletes a Project asset.
18. **RULE-D018:** Read models may join data for UI, but mutation authority remains with the owning module.

## Ownership matrix

| Module | Owns | Can read | Can write | Cannot access |
|---|---|---|---|---|
| Project | Project, Plan, lifecycle | identifiers from all modules | Project records | module internals |
| Director | Script, Storyboard | Project, Asset refs, AI contracts | Director records, Jobs | FFmpeg, publish/metrics internals |
| Asset | Asset, derivative, storage ref | Project refs | asset records/storage | business decisions |
| Video | Plan, Manifest, Render | Project, Asset, Job contracts | video records, render Jobs | Publisher/AI implementations |
| Publisher | Account, request, attempt | Project, Render asset, Job | publisher records, publish Jobs | Video/Director internals |
| Review | metric snapshot, review | Project, publish refs, AI contract | review records/jobs | platform browser automation |
| Job | Job, attempt, dependency | module contract refs | job state | module business data |
| AI | providers, model profiles, prompts, runs | Project/Job refs | AI records | Video/Publisher logic |
