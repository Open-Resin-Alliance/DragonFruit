# Golden masters (local only)

The support-store golden masters and their harness live in `/local-only/support-goldens/`,
which is gitignored. They are scaffolding for the support-registry refactor -- a
byte-for-byte baseline of the whole store, used to prove mechanical changes are
behaviour-preserving. They pin current behaviour rather than intended behaviour,
so they are not something the project should carry.

Run them:

    npx tsx --test local-only/support-goldens/*.test.ts

Re-record after an intended behaviour change:

    UPDATE_GOLDEN=1 npx tsx --test local-only/support-goldens/supportStateGoldenMaster.test.ts

Delete the folder once the refactor lands.
