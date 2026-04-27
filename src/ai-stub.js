// Stub for the dynamic `import('ai')` inside `agents/mcp` — we don't use the
// AI-SDK path. Returning a no-op `jsonSchema` keeps the bundler happy.
export const jsonSchema = (s) => s
