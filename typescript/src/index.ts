/**
 * zuno harness API 的 TypeScript SDK。
 *
 * ```ts
 * import { ZunoClient } from "@sohaha/zuno-sdk";
 * const client = await ZunoClient.connect({ clientName: "my-app/1.0" });
 * const session = await client.createSession(process.cwd());
 * const turn = await client.run(session.session_id, "hello");
 * console.log(turn.text);
 * client.close();
 * ```
 */

export * from "./protocol/harness-protocol.js";
export * from "./transport/socket-endpoint.js";
export * from "./transport/ndjson-framing.js";
export { HarnessError } from "./utils/harness-error.js";
export {
  launchInstance,
  inheritCredentials,
  userZunoHome,
  userAppConfigDir,
} from "./runtime/instance-launch.js";
export type { LaunchOptions, LaunchedInstance } from "./runtime/instance-launch.js";
export {
  bundledZunoBinary,
  ensureZunoBinary,
  platformBinaryPackage,
  cachedBinaryVersion,
  binaryDownloadUrl,
} from "./runtime/binary-installer.js";
export { ZunoClient, unixSocketTransport } from "./client/harness-client.js";
export type {
  SdkTool,
  SessionToolsOptions,
  ToolExecutionContext,
  ToolResult,
} from "./session/tool-callbacks.js";
export type {
  AssistantTextMessage,
  ConnectOptions,
  CreateSessionOptions,
  FileContent,
  FileStatus,
  GlobalEventsOptions,
  RunOptions,
  RunStructuredOptions,
  RuntimeInfo,
  SendMessageOptions,
  StructuredTurnResult,
  Transport,
  TurnResult,
} from "./client/harness-client.js";
export { StructuredOutputError } from "./utils/structured-output.js";
export type {
  StructuredOutputAttempt,
  StructuredOutputSchema,
  StructuredValidationIssue,
} from "./utils/structured-output.js";
