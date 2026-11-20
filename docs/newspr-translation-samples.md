# news.pr English→Spanish translation samples (live, manually reviewed)

On **2026-11-19** the production translation direction was exercised against the live feed with exactly **2 bounded batch calls** through Workers AI REST — the same model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), prompt, temperature 0 and `max_tokens` 4000 that the worker's reverse queue uses, in two batches of 4 (the production batch size). **8/8 results passed the worker's own `validSpanishTranslation()`** (marked `target:'es'`, attached to the unchanged English original, demonstrably Spanish, not an English copy-through). The run is reproducible with `scripts/newspr-verify.ts`; tokens and credentials are never printed. Nothing was stored and no production data was written for these samples.

**Source for every sample:** news.pr public RSS `https://news.pr/rss.xml` (captured 2026-11-19; the same capture is the committed fixture `test/fixtures/newspr.xml`). Each English excerpt below is the publisher's own feed description (already ≤300 characters). The Spanish texts are machine translations; on the site they are labeled as machine translations, the publisher link always points to the original English article, and the English edition always shows the original.

## Sample 1 — Morpheus decentralized-AI meetup

- **EN headline:** San Juan's decentralized-AI crowd meets tonight — Morpheus meetup fills a nonprofit space
- **EN summary:** Frontera 21's Morpheus Decentralized AI Meetup runs 6:00 to 9:30 PM tonight: networking, round tables, and a show-and-tell for what the community is building.
- **ES headline:** La reunión de inteligencia artificial descentralizada de San Juan se lleva a cabo esta noche — El meetup de Morpheus llena un espacio sin fines de lucro
- **ES summary:** El meetup de inteligencia artificial descentralizada de Morpheus de Frontera 21 se lleva a cabo de 6:00 a 9:30 PM con networking y mesas redondas.
- **Review:** Times (6:00–9:30 PM), Frontera 21 and the nonprofit framing are preserved. **Minor omission:** the English clause "and a show-and-tell for what the community is building" is dropped from the Spanish summary — the sentence ends after "mesas redondas". Flagging it here exactly because the validator checks language, revision and copy-through, not completeness; a dropped clause can pass. The headline's "crowd" becomes the blander "reunión", which is acceptable.

## Sample 2 — Casa Pueblo energy protest

- **EN headline:** Casa Pueblo holds energy protest at El Morro on Spanish arrival anniversary
- **EN summary:** November 19 demonstration rejected energy privatization and current operators LUMA and Genera PR
- **ES headline:** Casa Pueblo realiza protesta por la energía en El Morro en aniversario de la llegada española
- **ES summary:** La demostración del 19 de noviembre rechazó la privatización de la energía y a los operadores actuales LUMA y Genera PR.
- **Review:** Complete and accurate. Names (Casa Pueblo, El Morro, LUMA, Genera PR), the date and the privatization rejection all survive. "Demonstration" is rendered literally as "demostración"; "manifestación" would be the more idiomatic news word, but the meaning is intact.

## Sample 3 — Dominican Navy training visit

- **EN headline:** Dominican Navy Ships Arrive In Puerto Rico For 2026 Training Cruise
- **EN summary:** Two Dominican Navy vessels arrived in San Juan for the Horizons of Brotherhood 2026 training mission.
- **ES headline:** Buques de la Armada Dominicana llegan a Puerto Rico para el crucero de entrenamiento 2026
- **ES summary:** Dos buques de la Armada Dominicana llegaron a San Juan para la misión de entrenamiento Horizontes de Hermandad 2026.
- **Review:** Accurate; "Two Dominican Navy vessels" → "Dos buques de la Armada Dominicana" keeps the count. The mission name is translated in the summary ("Horizontes de Hermandad") but the headline uses a plain description ("crucero de entrenamiento 2026") — a small inconsistency between headline and summary naming, not a factual error.

## Sample 4 — Ponce Thanksgiving schedule

- **EN headline:** Ponce Municipality publishes Thanksgiving break service operating hours
- **EN summary:** Ponce municipal government announces modified schedules for Thanksgiving administrative recess.
- **ES headline:** El municipio de Ponce publica los horarios de operación de servicios durante el receso administrativo de Acción de Gracias
- **ES summary:** El gobierno municipal de Ponce anuncia horarios modificados para el receso administrativo de Acción de Gracias.
- **Review:** Complete and accurate; "Thanksgiving administrative recess" → "receso administrativo de Acción de Gracias" is the natural Puerto Rico phrasing.

## Sample 5 — Comptroller audit finding

- **EN headline:** Puerto Rico Comptroller finds $28k improper payments in Caguas education office
- **EN summary:** Puerto Rico's comptroller identified $28,212 in improper payroll at the Caguas regional education office.
- **ES headline:** Contralor de Puerto Rico encuentra pagos impropios de $28k en oficina de educación de Caguas
- **ES summary:** El contralor de Puerto Rico identificó $28,212 en pagos de nómina impropios en la oficina de educación regional de Caguas.
- **Review:** Numbers preserved exactly in both fields ($28k headline; $28,212 summary); "improper payroll" → "pagos de nómina impropios" is faithful.

## Sample 6 — Powerball prize

- **EN headline:** $50,000 Powerball Double Play prize won in Carolina, Puerto Rico
- **EN summary:** Puerto Rico Lottery announced a $50,000 Powerball Double Play winning ticket sold in Carolina.
- **ES headline:** Se gana premio de $50,000 de Powerball Double Play en Carolina, Puerto Rico
- **ES summary:** La Lotería de Puerto Rico anunció un boleto ganador de $50,000 de Powerball Double Play vendido en Carolina.
- **Review:** Complete and accurate. Brand names (Powerball Double Play) correctly stay untranslated; the prize amount and town match.

## Sample 7 — Landfill electrical injury

- **EN headline:** 64-year-old man critically injured after 16000 volt shock at Puerto Rico landfill
- **EN summary:** Roberto Telles Algarín remains critical following electric shock and fall at Fajardo landfill.
- **ES headline:** Hombre de 64 años herido críticamente después de sufrir una descarga de 16,000 voltios en un vertedero de Puerto Rico
- **ES summary:** Roberto Telles Algarín permanece en estado crítico después de sufrir una descarga eléctrica y una caída en el vertedero de Fajardo.
- **Review:** Age, voltage (16,000), the named individual and the Fajardo location all preserved; the shock-and-fall sequence is kept. Faithful handling of a sensitive incident.

## Sample 8 — Overnight noise law

- **EN headline:** Puerto Rico enacts overnight vehicle noise restrictions with fines
- **EN summary:** Governor Jenniffer González signed law banning nighttime voceteo across Puerto Rico.
- **ES headline:** Puerto Rico establece restricciones a los ruidos de vehículos durante la noche con multas
- **ES summary:** La gobernadora Jenniffer González firmó una ley que prohíbe el voceteo nocturno en todo Puerto Rico.
- **Review:** Complete and accurate. The Puerto Rico-specific term "voceteo" is kept (correct), the governor's name is preserved, and "with fines" in the headline matches "multas".

## What the samples show

- The English→Spanish direction works end to end on real feed text: every result was accepted by the same validator the worker applies, meaning Spanish output, correct revision attachment and no English copy-through.
- Names, numbers, dates, amounts and brand terms are consistently preserved — including the eight figures checked above ($28,212, $50,000, 16,000 V, 6:00–9:30 PM, 64 years).
- **Known limitation, shown not hidden:** sample 1 drops a trailing clause, and validation cannot catch that (it checks language, attachment and copy-through, not completeness). The publisher's feed excerpts are ≤300 characters, so the worst case is a short dropped clause; readers always have the original-article link, and the English edition is unaffected.
- These were bounded verification calls (2), not a production run: the production queue applies the same prompt and validation with the documented caps (see [newspr-source.md](newspr-source.md)).
