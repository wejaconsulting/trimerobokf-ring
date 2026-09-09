# Autonomi — hur systemet tar över rutinarbetet

Det här dokumentet är skrivet för Trimeros, inte för utvecklaren. Det beskriver vad systemet
gör själv, vad som fortfarande kräver en människa, och exakt vilka brytare som styr det.

---

## Grundidén

Systemet ska inte "bokföra allt". Det ska **göra rutinarbetet självt och lämna undantagen
till en konsult**. Varje post i en period hamnar i en av fyra korgar:

| Korg | Vad det betyder | Vem gör något |
| --- | --- | --- |
| **Klart utan anmärkning** | Posten passerade alla valideringar och avvikelseregler. | Ingen. |
| **Automatisk** | Systemet hittade ett fel och har ett förslag som passerat samtliga hårda grindar med score ≥ 0,85. | Systemet — om klientens policy tillåter. |
| **Review** | Ett förslag finns, men något gör att en konsult ska titta (t.ex. underlag saknas, belopp avviker). | Konsulten godkänner, ändrar eller avvisar. |
| **Manuell bedömning** | Momsbehandling osäker, väsentligt belopp, låst period, motstridiga regler eller en Fortnox-funktion som saknar API. | Konsulten. |

**Automationsgraden** på byråöversikten är andelen poster i de två första korgarna. Det är
det tal som visar hur mycket arbete som inte längre kräver någon.

---

## Vad systemet gör själv, steg för steg

1. **Läser bokföringen från Fortnox** — räkenskapsår, kontoplan, verifikationer med rader,
   leverantörs- och kundfakturor, betalningar, kostnadsställen, projekt och låst period. Allt
   normaliseras till öre och till systemets egna datatyper innan någon regel ser det.
2. **Kör de deterministiska reglerna** över varje verifikationsrad och jämför mot 12 månaders
   historik. Reglerna är kod, inte en språkmodell, och varje avvikelse har en förklaring på
   svenska.
3. **Skapar bokföringsförslag** med exakt den payload som skulle skickas till Fortnox, och en
   hash av den.
4. **Godkänner själv** de förslag som ligger på nivån *Automatisk* — om klientens policy har
   *Låt systemet godkänna förslag på nivån Automatisk själv* påslaget. Godkännandet sparas
   som ett beslut med systemet som aktör, bundet till förslagets hash.
5. **Bokför** godkända förslag i Fortnox — om **alla sju villkoren** i skrivgrinden är
   uppfyllda (se nedan). Annars stoppas förslaget, och orsaken loggas.
6. **Skriver konsultrapporten** — det enda steget där en språkmodell används, och den får
   bara formulera det som redan är avgjort.

Vad som blir kvar för människan: review-kön, den manuella bedömningen, och de processteg
som Fortnox publika API inte täcker (banktransaktioner, skattekonto, begär underlag — se
[capability-matrisen](./fortnox-capability-matrix.md)).

---

## Brytarna, i den ordning de måste slås på

Systemet levereras **avstängt**. Att sätta det i drift är en trappa, och varje steg är
oberoende av de andra:

| Steg | Var | Vad det gör |
| --- | --- | --- |
| 1. Anslut klienten | Konsolen → Fortnox-anslutning | Marcus loggar in i Fortnox och ger **läsbehörighet**. Ingen skrivbehörighet begärs. |
| 2. Läs riktiga data | Servern: `FORTNOX_ADAPTER=auto` | Anslutna klienter läses från Fortnox; klienter utan anslutning körs på demodata (eller blockeras med `real`). Fortfarande shadow mode. |
| 3. Låt systemet godkänna | Konsolen → klientens inställningar | `autoBookEnabled`. Systemet godkänner Automatisk-nivå själv. Inget bokförs ännu. |
| 4. Stäng av shadow mode | Servern: `SHADOW_MODE=false` | Skrivgrindens villkor 1. Fortfarande bokförs inget. |
| 5. Sätt skrivflaggan | Servern: `FORTNOX_WRITES_ENABLED=true` + `FORTNOX_WRITES_ACKNOWLEDGEMENT` | Servern **vägrar starta** om frasen saknas, om shadow mode är på, eller om adaptern är `mock`. |
| 6. Slå på skrivning per klient | Konsolen → Fortnox-anslutning → *Skrivbrytare för klienten* | Villkor 3. Loggas som administrativ åtgärd. Kan inte slås på medan shadow mode är aktivt. |

Frasen i steg 5 är exakt:

```
FORTNOX_WRITES_ACKNOWLEDGEMENT=JAG FÖRSTÅR ATT DETTA BOKFÖR PÅ RIKTIGT I KLIENTERNAS FORTNOX
```

Rekommenderad ordning i praktiken: kör **minst en hel period per klient i steg 2–3** och
läs igenom de automatiskt godkända förslagen i konsolen. Om konsulten håller med om dem —
gå vidare. Om inte — justera policy och klientregler först.

---

## Skrivgrinden: sju villkor, alla måste vara sanna

Varje enskilt förslag prövas för sig, i det ögonblick det ska bokföras:

```
1. SHADOW_MODE är av
2. FORTNOX_WRITES_ENABLED är på (med bekräftelsefrasen)
3. Klientens egen skrivbrytare är på
4. Ett godkännandebeslut finns (av konsult eller av systemet enligt policy)
5. Beslutets hash är exakt lika med hashen av det som ska skickas
6. Perioden är inte låst i Fortnox (läses färskt vid bokföringen)
7. Verifikationen balanserar
```

Villkor 5 är det viktiga. Om någon ändrar ett förslag efter godkännandet — ett konto, ett
belopp, en beskrivning — så ändras hashen, grinden stoppar, och konsulten måste godkänna på
nytt. Ett godkännande kan aldrig återanvändas för andra byte.

Dessutom: samma bokföring görs aldrig två gånger. Hashen på det som bokförts sparas per
klient, och en omkörning visar förslaget som *Redan bokförd* i stället för att skapa en ny
verifikation.

---

## Vad som aldrig händer, oavsett brytare

- Systemet **ändrar eller tar bort** aldrig något i Fortnox. Den enda skrivningen är att
  skapa en ny verifikation.
- Systemet **låser aldrig** en period.
- Systemet **skickar aldrig mejl** till klientens kunder. Utkast skapas; ingenting sänds.
- Språkmodellen får aldrig en token, en databas eller en möjlighet att fatta beslut.
- Ingen browserautomation mot Fortnox. Saknas ett API rapporteras steget som *ej
  implementerat* och blockerar att perioden rapporteras komplett.

---

## Hur det verifieras

| Påstående | Test |
| --- | --- |
| Riktig adapter läser ett Fortnox-format korrekt (öre, sidindelning, borttagna rader, bilagor, leverantörskoppling) | `packages/fortnox/src/real-adapter.test.ts` |
| En körning mot ett Fortnox-API når samma avvikelser som mot demodata | `packages/workflow/test/autonomy.itest.ts` |
| Systemets egna godkännanden binds till hash och loggas med systemet som aktör | samma |
| I shadow mode skickas ingenting, och varje stoppat förslag har sina orsaker i auditloggen | samma + `scripts/smoke.ts` |
| Med alla brytare på bokförs exakt de godkända bytena, en gång, och en omkörning bokför inte igen | samma |
| Ett förslag ändrat efter godkännande stoppas; klientens brytare av stoppar | samma |
| Servern vägrar starta med skrivflaggan utan shadow mode av, bekräftelsefras och riktig adapter | `apps/api/test/deploy-config.itest.ts` |
