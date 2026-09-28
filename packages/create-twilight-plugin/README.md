# create-twilight-plugin

Scaffold and package Twilight Echo plugins. This CLI currently lives in the Twilight Echo source tree; it is not published to npm yet.

```bash
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs init ../my-tool --type tool --id com.example.my-tool
# After writing and building the plugin:
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack ../my-tool
```

Run these commands from the Twilight Echo repository root. `pack` validates `plugin.json` and creates `../my-tool/dist/com.example.my-tool-1.0.0.tep`. The generated TypeScript templates refer to `@twilight-echo/plugin-api` and this CLI as development dependencies; both packages are currently available from this repository rather than the npm registry. For a dependency-free JS plugin and the current GitHub Release publishing flow, follow the [plugin development guide](../../docs/PLUGIN_README.md#14-发布到插件市场).

The `theme` scaffold targets plugin API v3 and structured theme schema v3. It demonstrates stable
tokens and host-registered modes while retaining the legacy packaged stylesheet path.
