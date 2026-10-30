# CS agent, one page

Customer success teams lose renewals in the gaps: nobody noticed the champion left, the tickets piled up, or the renewal is two weeks away with no meeting booked. This agent reads those accounts in HubSpot and does the next safe step itself.

## What it does

When you run the renewal sweep, it looks at accounts whose renewal is coming up. It writes a health score on the company, with the reasons and the HubSpot records those reasons came from. When the account is at risk it creates a task for the owner. When a customer email should go out, it drafts the email and waits. A person approves the exact draft. The agent never sends email.

Critical accounts, and large at-risk accounts, are handed to the CS lead as well.

## How it stays safe

The model is not allowed to change HubSpot. It can read and it can propose. One module, commit, is the only writer.

A person approves a specific change, not a vague intent. If anyone edits the draft, the old approval does not apply. Running the job twice does not create a second task or a second note.

The health score is a formula your team can read. The model explains it. The model does not get to pick the number. Notes and emails are treated as customer words, not as orders. A test account contains a note that tries to override the rules. The agent does not obey it.

You can run the first weeks in shadow: it proposes everything and writes nothing, so the team can see what it would have done.

## What week 1 looks like

You share a HubSpot test portal and a read of how your fields are named. We fill in a config file, not a new integration. The agent runs in shadow on real accounts. You see the scores, the reasons, and the drafts. Nothing is written until you say so.

The working demo of that loop already runs without your portal: `pnpm demo:mock`.

## What it will not do in this version

It will not send email, change a deal stage on its own, or talk to Slack. Those are later, behind the same approval step.
