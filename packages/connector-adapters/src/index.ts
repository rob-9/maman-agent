export { fetchTransport, type HttpRequest, type HttpResponse, type HttpTransport } from "./http.js";
export {
  MemoryIdempotencyStore,
  throwForStatus,
  throwTransientNetwork,
  type CredentialProvider,
  type ProviderCredentials,
  type IdempotencyStore,
} from "./credentials.js";
export {
  salesforceCapabilities,
  SF_API_VERSION,
  DEFAULT_SF_FIELD_MAP,
  type SalesforceFieldMap,
  type SalesforceAdapterConfig,
} from "./salesforce.js";
export { googleSheetsCapabilities, type GoogleSheetsAdapterConfig } from "./google-sheets.js";
export {
  realAdapterRegistry,
  ConnectorNotLinkedError,
  type RealRegistryConfig,
} from "./registry.js";
export {
  parseAddress,
  parseAddressList,
  isSelf,
  projectThread,
  projectThreads,
  projectContent,
  type GmailHeader,
  type GmailMessage,
  type GmailThread,
  type Participant,
  type ProjectedThread,
  type ProjectedMessage,
  type ContentMessage,
  type ThreadContent,
} from "./gmail-project.js";
export {
  syncGmailThreads,
  type GmailSyncConfig,
  type GmailSyncOptions,
  type GmailSyncResult,
} from "./gmail.js";
export type { UserCredentialKey, UserCredentialProvider } from "./credentials.js";
export {
  buildRawMessage,
  createGmailDraft,
  type DraftMessage,
  type CreateDraftResult,
} from "./gmail-draft.js";
export type { DealAnswer, DealSignal, DealSource } from "./deals.js";
export {
  salesforceDealSource,
  SF_DEAL_QUERY_CHUNK,
  type SalesforceDealSourceConfig,
} from "./salesforce-deals.js";
export {
  bodyText,
  CONTENT_MAX_CHARS,
  CONTENT_MAX_MESSAGES,
  STORED_MAX_CHARS,
  stripHtml,
  stripQuoted,
  type GmailMessageFull,
  type GmailThreadFull,
} from "./gmail-body.js";
export {
  gmailContentReader,
  type GmailContentConfig,
  type ThreadContentReader,
} from "./gmail-content.js";
