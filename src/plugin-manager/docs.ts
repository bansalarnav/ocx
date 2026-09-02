export const pluginDocs = `# OpenCode plugin projects

Write an ordinary OpenCode plugin project in the workspace. Do not invent a manifest or return the project as JSON. Use the filesystem tools to create and edit files. When you finish, the plugin manager builds and activates the project automatically.

The workspace may contain:

- \`server.ts\` or \`server.js\` for code that runs in the Durable Object
- \`tui.tsx\` for code that will run in the local OpenCode TUI once client sync exists
- \`package.json\` for external npm dependencies
- any relative modules imported by either entrypoint

At least one entrypoint is required. If both entrypoints exist, both must use the same literal plugin ID. IDs match \`[A-Za-z0-9_-]{1,64}\`. Names are kept exactly as written. Do not add a \`generated_\` or \`tui_\` prefix.

## Server plugins

Server code uses the normal Promise plugin format:

\`\`\`ts
import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "hello",
  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "hello",
        description: "Say hello",
        input: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input) {
          return { content: "Hello " + input.name }
        },
      })
    })
  },
})
\`\`\`

The server runs the bundled module in QuickJS. The current context bridge implements \`ctx.tool.transform\`, \`ctx.tool.reload\`, and \`ctx.storage\`. Tools registered here appear beside the plugin manager's tools. The main agent calls them directly.

## TUI plugins

TUI code uses the normal TUI plugin format:

\`\`\`tsx
import { Plugin } from "@opencode-ai/plugin/tui"

export default Plugin.define({
  id: "hello",
  setup(ctx) {
    return ctx.ui.slot({
      append: "sidebar.footer",
      render({ sessionID }) {
        return <text>Session: {sessionID}</text>
      },
    })
  },
})
\`\`\`

The pinned client API uses the named \`Plugin\` export and \`Plugin.define({ id, setup })\`. There is no default export from \`@opencode-ai/plugin/tui\`. Register UI with \`ctx.ui.slot(...)\`. Supported slots include \`app\`, \`home.footer\`, \`prompt.footer\`, \`prompt.footer.status\`, \`prompt.footer.file\`, \`session.composer.top\`, \`sidebar.content\`, and \`sidebar.footer\`. To add content inside the existing right sidebar, append to \`sidebar.content\`. Use \`ctx.ui.toast.show({ variant, message })\` for toasts.

The local TUI API also includes \`ctx.keymap\`, \`ctx.renderer\`, \`ctx.data\`, \`ctx.client\`, \`ctx.storage\`, themes, attention notifications, and Markdown renderers. The server bundles and stores \`tui.tsx\`. Connected \`ocx\` clients ask for local approval, verify the artifact, and load it. Later edits hot-reload on every connected and approving client. Return cleanup functions from registrations so the previous version can be removed cleanly.

## Dependencies

Use relative imports normally. Put external packages in \`package.json\`:

\`\`\`json
{
  "dependencies": {
    "date-fns": "latest"
  }
}
\`\`\`

The runtime bundler resolves npm registry versions, ranges, and tags. It rejects URL, Git, local-file, workspace, and npm-alias specifiers. Server packages must work as bundled JavaScript in QuickJS. Native addons and packages that depend on unavailable Node or browser globals will fail validation. OpenCode, OpenTUI, and Solid runtime imports stay external in TUI bundles. Other TUI dependencies are bundled.

## Research and completion

Use web search and web fetch when you need current OpenCode or package documentation. Inspect package APIs instead of guessing. Finish only after writing the project files. The manager will run structural checks, resolve packages, bundle both entrypoints, inspect the server bundle, store the source, hot-activate server tools, and reload the tool catalog. If a check fails, fix the workspace using the diagnostic you receive.
`
