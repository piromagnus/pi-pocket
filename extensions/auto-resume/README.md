# Auto-resume (legacy drop-in)

This package preserves the former custom auto-resume module. It is disabled by default. Keep it disabled while Pi Pocket 0.21.0 uses its built-in request limit gate.

## Install

Copy these 3 runtime files into the app data folder's `extensions/` directory:

- `auto-resume.ts`
- `auto-resume.js`
- `_usage-limits.ts`

For the default data folder:

```sh
mkdir -p ~/.pi-pocket/extensions
cp auto-resume.ts auto-resume.js _usage-limits.ts ~/.pi-pocket/extensions/
```

Run the commands from this directory. For a custom data folder, copy the files into its `extensions/` directory. Pi Pocket provides the package link and `_pocket.d.ts` there. The module loads off by default. Turn it on only from **Menu → Extensions** after you review its behavior.

## Disable

Use **Menu → Extensions → Auto-resume** and turn the module off. The owner can also call:

```http
POST /api/extensions/auto-resume.ts
Content-Type: application/json

{"enabled":false}
```

This stops the extension hook. It does not cancel an already scheduled retry. Cancel schedules with the `[usage reset]` message in **Scheduled messages** before disabling the module.

## Compatibility and data

This is a legacy module, not a 0.21.0 replacement for Pi Pocket's built-in `LimitGate`. It preserves the document kinds `x.auto-resume.chat` and `x.auto-resume.settings`, their existing version and scope semantics, and the schedule key prefix `x.auto-resume:`. Do not rename or delete these definitions while stored data may use them.

The module uses `host.pip.ownerOf` and `host.schedules`, which are internal host capabilities. Pi Pocket does not promise compatibility for these capabilities across releases. Keep the module disabled after upgrades until its source and tests pass against that release. Keep **Scheduled messages** enabled while any of its schedules exist.
