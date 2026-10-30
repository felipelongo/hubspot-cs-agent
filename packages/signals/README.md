# Signals

Turns raw records into facts like "no meeting in 47 days" or "3 open high-severity tickets".

**Why it exists.** The score and the write-up should both start from the same facts, each fact pointing at a HubSpot record.

**One sentence.** "Turns raw records into facts like 'no meeting in 47 days' or '3 open high-severity tickets'."

**Public interface.** `computeSignals(bundle, clock) → Signal[]`. Sentiment and budget risk use a fixed phrase list so the number does not depend on the model. The model still writes the explanation.
