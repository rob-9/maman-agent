/**
 * The organization-level vault provider moved to @maman/sync so the API can
 * share it. Re-exported under the worker's historical names.
 */
export {
  createOrgVaultCredentialProvider as createVaultCredentialProvider,
  type OrgVaultDeps as VaultCredentialDeps,
} from "@maman/sync";
