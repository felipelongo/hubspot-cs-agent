# Account bundle

Gathers everything about one customer into one package with record ids.

**Why it exists.** Procedures and signals should not each make their own HubSpot calls and disagree about what they saw.

**One sentence.** "Gathers everything about one customer (company, contacts, renewal, tickets, activity) into one package with record IDs."

**Public interface.** `buildAccountBundle({ companyId, hubspot, portal, clock }) → AccountBundle`. The returned `bundle_hash` covers the normalized contents.
