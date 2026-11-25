# Russian war deaths in the Rosstat leaks: the count of 497,396

One row per Russian war death found in the Rosstat leaks (https://rosstat-leaks.com/): the leaked Russian civil death register and the
SMEV broadcast of death records, deaths from 24 February 2022 to 28 September 2026, acts drawn up to 29 September 2026.

## How the deaths were selected

Each act once, in its latest version (the broadcast's version where it has the act, else the register's), and each person once (same
birth date, sex, death date and region). Men, Russian citizens, by one of these steps (column `step`):

- `strict`: aged 18-64 with a military cause of death: ICD-10 Y36 or Y89.1, death type 6 "military action", or military wording in the
  cause; likely civilians of the front regions left out (a military cause without military employment where the man was born or lived in
  the region he died in)
- `emp5`: aged 18-64, employment "military service", whatever the cause
- `spravka`: aged 18-64, the act rests on a death notice (issued when no medical certificate can be) and he did not die in Russia
- `court`: aged 18-65, a court declared him dead or established the fact of death, the place of death a combat area or unknown
- `nocause`: aged 18-65, no cause given, died in a combat area
- `rostov`: an act of one of the two Rostov registry offices that register the military dead

Home region: the residence in the act or the broadcast; where there is none, the registry office's usual municipality, the birthplace or
the region (column `home_how`). Place of death: geocoded from the act's wording (`death_how`); `death_kind` none for the missing
declared dead by a court and others with no place.

## What is not in it

No names, no full birth dates (only the year), no street addresses and no document numbers. In the free text, everything from a street or
house onwards is cut from the place of death and the birthplace, home settlements that read as a street are blank, and runs of five or
more digits (case and document numbers) are replaced by #.

## Files

- `rosstat-leaks-count-497396.csv.zip`: the table, 497,396 rows, UTF-8 CSV with a byte order mark (opens in Excel and Numbers)
- `SHA256SUMS`: checksums

## Columns

- `id`: act record id (the register's Meta.FactId / the broadcast's act id)
- `step`: filter step that took the death into the count (strict, emp5, spravka, court, nocause, rostov)
- `source`: which data have the act: both, smev (broadcast only) or reg (register only)
- `compact_source`: whose version of the act the count used: smev or register
- `version`: version of that act
- `record_status`: record status of that version
- `death_date`: date of death
- `act_date`: date the act was drawn up
- `doc_date`: date of the document the act rests on
- `age`: age at death
- `birth_year`: year of birth
- `sex`: sex code (1 man)
- `citizenship`: citizenship code (643 Russia)
- `employment`: employment code (5 military service)
- `death_type`: type of death code (6 military action)
- `circumstance`: circumstance code
- `doc_type`: document the act rests on (17002 medical certificate, 17007/17000 death notice, 17005/17003 court)
- `cause_codes`: cause of death codes (ICD-10), ; separated
- `cause_text`: cause of death wording, | separated
- `death_region_text`: region of death as written in the act
- `death_place_text`: place of death as written in the act
- `residence_region_text`: region of residence as written in the act
- `birth_region_text`: region of birth as written in the act
- `birth_place_text`: place of birth as written in the act
- `office`: registry office code
- `home_how`: how the home was found (smev, register, office, birth, region, office-region, code-region, birth-region, office-location)
- `home_level`: finest level of the home known
- `home_region`: home region
- `home_district`: home district
- `home_town`: home town
- `home_settlement`: home settlement
- `home_oktmo`: home OKTMO code
- `home_okato`: home OKATO code
- `death_kind`: place of death found: place (settlement), oblast, interior (in Russia) or none
- `death_how`: how the place of death was found
- `death_oblast`: oblast of death
- `death_place`: settlement of death (geocoded)
- `death_lat`: latitude of the place of death
- `death_lon`: longitude of the place of death
- `death_region`: region of death in Russia (deaths inside Russia)

Codes as in the register: sex 1 man; citizenship 643 Russia; employment 5 military service; death type 6 military action; document 17002
medical certificate, 17007/17000 death notice, 17005/17003 court decision.

## Source

The Rosstat leaks, https://rosstat-leaks.com/. Selection, home regions and places of death: @m0nstas.
