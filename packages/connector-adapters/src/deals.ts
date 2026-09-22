/**
 * THE CRM SEAM: what a CRM tells us about a contact, independent of which CRM.
 *
 * The detector needs exactly one thing from a CRM — is there an open deal with
 * this person, and how big — so that is the whole contract. Salesforce and
 * HubSpot implement it against their own objects (Opportunity / Deal); the
 * sync job, the repository and the detector never learn which one answered.
 *
 * Three states, and the third is the important one. `true`: an open deal.
 * `false`: the CRM has deals with this person and NONE is open — a finished
 * relationship, which the detector suppresses. A person the CRM has never
 * heard of, or knows without any deal, is NOT returned at all: their state
 * stays unknown (null) and they rank as before. Mapping "not in the CRM" to
 * `false` would hide every prospect a rep has not entered yet, which is most
 * of them on most days.
 */

export type DealSignal = {
  /** The contact's address, as the mailbox connector keyed it. */
  address: string;
  /** `false` ONLY for "deals exist and all are closed". See above. */
  has_open_deal: boolean;
  /** Sum of open deal amounts, whole currency units. Absent when none. */
  open_deal_value?: number;
  /** The CRM's account/company name, when it has one. */
  account_name?: string;
};

export type DealAnswer = {
  asked: readonly string[];
  signals: readonly DealSignal[];
};

export interface DealSource {
  readonly provider: string;
  /**
   * Looks up open deals for these addresses on behalf of one person. The CRM
   * connection is the organization's; the question is scoped to this
   * person's own contacts, which is the only list a caller can hold.
   */
  lookup(
    ctx: { organization_id: string; user_id: string },
    addresses: readonly string[],
  ): Promise<DealAnswer>;
}
