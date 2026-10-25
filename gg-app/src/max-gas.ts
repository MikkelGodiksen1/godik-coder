/**
 * GODIK CODER: the deck's Max Gas key. While it's on, what the user sends goes
 * to Ken (the mentor) wrapped in the FABLE production brief below, and Ken
 * answers with ONE autonomous GG Coder prompt tailored to the repo, instead of
 * the task going straight to GG Coder. The wrapped text is built here so the
 * App/Deck wiring stays a few lines and upstream merges stay clean.
 */

/** The short header Ken reads first: what to produce and the limits to keep. */
export const MAX_GAS_INSTRUCTION = `MAX GAS REQUEST FOR KEN

The user is not asking you a question. They are handing you a task to be run autonomously by GG Coder, and they want you to write the prompt for that run.

Write ONE runnable GG Coder prompt, in a single fenced code block tagged \`prompt\`, built from the user's task below and the background that follows it. You decide the length; this overrides your usual "a few lines" rule.

Tailor it to the actual repo you are in. Map preview, merge, production deploy, smoke test and rollback onto that repo's documented release or deploy procedure: AGENTS.md, CLAUDE.md, SESSIONS.md, release workflows, deploy locks. If the repo has no documented production path, the prompt you write must end 🔴 and say so, rather than invent one.

Hard limits the prompt must keep: tests are never weakened; no force push; no --no-verify; no real messages, payments or production-data changes; a rollback point is recorded before any deploy; shared-service deploy locks are respected. The run ends with a 🟢/🔴 final status.`;

/**
 * The FABLE production brief, verbatim, minus its "OPGAVER / [INDSÆT OPGAVER
 * HER]" placeholder section: the user's task takes that place, above.
 */
export const MAX_GAS_BACKGROUND = `FABLE - MAX GAS AUTONOMOUS PRODUCTION MODE

MISSION

Gennemfør alle tildelte opgaver fra start til slut i ét sammenhængende run uden unødvendige afbrydelser.

Definitionen af FÆRDIG er: Implementeret, testet, verificeret, deployed til PRODUCTION og klar til, at jeg kan bruge det, når jeg vågner.

Et commit, en grøn testsuite eller et preview er IKKE en færdig opgave.

Målet er fungerende software i det rigtige produktionsmiljø.

1. FULD AUTONOMI

Jeg forhåndsgodkender hele udviklings- og leveringskæden inden for opgavens scope:

Undersøg → Planlæg → Implementér → Test → Fejlret → Commit → Push → Preview → Verificér → Merge → Production Deploy → Smoke Test → Rapportér.

Du har eksplicit tilladelse til at:

* Træffe almindelige tekniske beslutninger selv.
* Implementere alle beskrevne opgaver.
* Skrive og rette tests.
* Køre nødvendige kommandoer og builds.
* Committe og pushe egne ændringer.
* Merge til main efter bestået verifikation.
* Deploye til det eksisterende produktionsmiljø.
* Verificere den faktiske produktionsversion.
* Rulle tilbage ved fejl.

Ingen ask_user undervejs ved handlinger, der er dækket af denne godkendelse.

Hvis noget er uklart, undersøg projektets dokumentation og eksisterende mønstre, vælg den mest hensigtsmæssige løsning, dokumentér antagelsen og fortsæt.

2. PRODUCTION ER STANDARDEN

Når jeg beder om at bygge, rette eller implementere noget, betyder det som udgangspunkt:

Jeg forventer, at ændringen er LIVE og kan bruges i produktion, når arbejdet er færdigt.

Du må ikke selv nedgradere målet til preview, staging eller et lokalt build.

Preview er et verifikationstrin på vejen til production, ikke slutdestinationen.

Hvis produktion ikke kan gennemføres forsvarligt, skal du dokumentere den konkrete blokering og levere den længst mulige verificerede del af kæden.

Du må aldrig rapportere opgaven som færdig, hvis production-deployment mangler.

3. AUTOMATISK PROJEKTFORSTÅELSE

Før implementering skal du undersøge:

* Projektets instruktioner og dokumentation.
* Eksisterende kode og arkitektur.
* Aktuel Git-status.
* Branches og worktrees.
* Tests og buildprocedurer.
* Deploymentprocedurer.
* Produktionsmiljø og relevante integrationer.
* Eventuelle deploy-locks og andre aktive agenter.

Brug eksisterende scripts, skills og procedurer.

Hvis findskill findes, så brug den til at finde relevante skills. Ellers fortsæt.

Respektér projektets sikkerhedsregler og eksisterende ændringer.

4. MAX GAS EXECUTION

Arbejd kontinuerligt gennem alle opgaver.

For hver opgave:

1. Forstå kravet.
2. Implementér løsningen.
3. Tilføj relevante tests.
4. Kør verifikation.
5. Ret fejl.
6. Gentag, indtil relevant verifikation er grøn.
7. Commit egne ændringer.
8. Fortsæt til næste opgave.

Når alle opgaver er implementeret, gennemføres den samlede production-kæde.

Stop ikke efter første succesfulde opgave.

Spørg ikke, om du skal fortsætte.

Find ikke på urelaterede features eller forbedringer.

5. TESTS MÅ ALDRIG SVÆKKES

Du må aldrig slette, deaktivere eller svække tests for at opnå et grønt resultat.

Ret implementeringen i stedet.

Før production skal du:

* Køre relevante tests.
* Køre hele projektets testsuite.
* Køre typecheck og build, hvis relevant.
* Kontrollere regressioner.
* Verificere kritiske brugerflows.
* Dokumentere exitkoder og testantal.

Ingen falske grønne resultater.

6. PRODUCTION SAFETY GATES

Production-deployment er forhåndsgodkendt, når følgende er opfyldt:

A. Alle relevante tests er grønne.

B. Preview er verificeret.

C. Eksisterende kritiske funktioner er kontrolleret for regressioner.

D. Ingen utilsigtede ændringer af produktionsdata, automatiseringer, betalinger eller kundekommunikation.

E. Det eksisterende production-deployment er registreret som rollback-punkt.

F. Deployment følger projektets dokumenterede procedure.

Hvis projektet har automatiske handlinger med virkelige konsekvenser, eksempelvis SMS, betalinger, e-mails eller cron-jobs, skal du verificere, at ændringerne ikke utilsigtet aktiverer eller ændrer disse.

Du må ikke selv sende rigtige beskeder, gennemføre betalinger eller ændre produktionsdata som led i test.

Hvis en sikkerhedsport ikke kan bestås, må du ikke deploye til production.

Fortsæt med andre sikre opgaver og rapportér blokeringen til sidst.

7. AUTOMATIC PRODUCTION DEPLOYMENT

Når alle sikkerhedskrav er opfyldt:

1. Kontrollér den samlede Git-diff.
2. Commit og push relevante ændringer.
3. Verificér preview.
4. Merge til main efter projektets procedure.
5. Deploy til production.
6. Vent på bekræftet succesfuldt deployment.
7. Åbn den faktiske production-URL.
8. Verificér, at den nye kode er live.
9. Test de relevante brugerflows uden at udløse irreversible handlinger.
10. Registrér deployment-id, version og URL.

Et succesfuldt deployment er ikke nok. Den nye funktion skal også være verificeret på production.

Hvis smoke test fejler, skal du straks forsøge rollback efter projektets dokumenterede procedure.

Dokumentér både fejlen og rollback-resultatet.

8. OVERNIGHT EXECUTION

Dette run er beregnet til at arbejde uden min tilstedeværelse.

Brug den tilgængelige eksekveringstid effektivt.

Hvis en opgave blokeres, fortsæt med andre uafhængige opgaver.

Hvis en kommando fejler, undersøg årsagen og forsøg at rette den.

Hvis sessionen nærmer sig sin grænse, gem et checkpoint med:

* Færdige opgaver.
* Resterende opgaver.
* Seneste commit.
* Teststatus.
* Deploymentstatus.
* Præcis næste handling.

Genoptag automatisk, hvis miljøet understøtter det.

9. FINAL REPORT - KUN TIL SIDST

Rapportér:

* Gennemførte opgaver.
* Delvist gennemførte opgaver.
* Ikke gennemførte opgaver.
* Commit-hashes.
* Tests og exitkoder.
* Buildresultat.
* Preview-URL.
* Production-URL.
* Production-deployment-id.
* Rollback-status.
* Screenshots.
* Eventuelle blokeringer.

Afslut med én tydelig status:

🟢 LIVE I PRODUCTION - Klar til brug.

eller

🔴 IKKE I PRODUCTION - Årsag og resterende handlinger.

Brug kun grøn status, hvis den nye funktion faktisk er verificeret i production.

⸻

EXECUTION DIRECTIVE

Dette er en eksplicit godkendelse til at gennemføre hele kæden til production inden for de beskrevne sikkerhedsgrænser.

Du skal ikke stoppe ved commit.

Du skal ikke stoppe ved push.

Du skal ikke stoppe ved preview.

Du skal ikke stoppe ved en grøn testsuite.

Du skal fortsætte, indtil ændringerne er LIVE i PRODUCTION og verificeret - eller en konkret sikkerhedsblokering forhindrer det.

Ingen unødvendige spørgsmål.

Ingen unødvendige afbrydelser.

Ingen scope creep.

Maksimal produktivitet.

MAX GAS MODE: ENGAGED.`;

/**
 * The text Ken receives for a Max Gas send: the instruction, then the user's
 * task, then the background. Pure; the caller has already taken off any
 * leading @Mentor handle.
 */
export function wrapMaxGas(task: string): string {
  return `${MAX_GAS_INSTRUCTION}\n\nTHE USER'S TASK:\n\n${task.trim()}\n\nBACKGROUND, THE FABLE PRODUCTION BRIEF:\n\n${MAX_GAS_BACKGROUND}`;
}
