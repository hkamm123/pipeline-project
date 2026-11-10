# Sound design: Anchorage tides → ambient music

Station: NOAA CO-OPS 9455920 (Anchorage, AK). Datum: MSL. Water level is the only sensor
(microwave gauge); there are no wind, temperature or pressure sensors.

The page plays generative ambient music in the browser (Tone.js). It reads only what the
pipeline produces (`latest.json`), never the NOAA API, so what you hear is proof the
pipeline is alive.

## Data inputs (what the pipeline provides)

| Input | Source | Typical range at Anchorage |
|---|---|---|
| `level`: water level | observed 6-min, MSL | about -5.5 to +5.5 m |
| `rate`: rate of change | derived from consecutive readings | about -3 to +3 m/h (floods fast) |
| `turn`: high/low tide event | predictions, hilo | 4 per day (an event, not a value) |
| `residual`: observed - predicted | joined at the same timestamp | usually ±0.5 m |
| `residual_pct`: residual vs. history | percentile for this station + month, from the seed | 0-100 |
| `range_today`: tidal range today | predictions (spring vs. neap tides follow the moon) | about 5-10 m |
| `sigma`: choppiness | std. dev. inside each 6-min sample | 0-0.2 m |
| `gap`: failed-QC / missing reading | `v` is blank (stored as NULL) | event |
| `staleness`: data age | now - latest ingested reading | minutes; > 60 means trouble |

Between pipeline runs the page "nowcasts": it follows the prediction curve plus the latest
residual, and the chart draws that part dotted so measured and estimated are distinct.

## Default mappings

| Input | Sound parameter | Feel |
|---|---|---|
| `level` | filter cutoff + pad swell | high tide is open and bright, low tide is dark and muffled |
| `rate` | arpeggio direction + note density | rising tide climbs; faster change, more notes; slack water is sparse |
| `turn` | bell / chime trigger | marks each high and low tide |
| `residual` | tension: detune, noise, dissonant intervals | the weather pushing the sea off-script |
| `residual_pct` | mode | typical → Lydian/Ionian, unusual → Dorian/Aeolian, extreme → Phrygian |
| `range_today` | reverb size + overall dynamics | spring tides breathe big, neap tides stay small |
| `sigma` | shimmer / sparkle texture | choppy water sparkles |
| `gap` | brief dropout or static crackle | data gaps are audible |
| `staleness` | decay to a lone drone past ~60 min | you can *hear* the pipeline die |

## Control panel (user can tweak the sound)

The mappings above are only defaults. The UI exposes them as a **modulation matrix**, like
a synthesizer: any data input can drive any sound parameter.

**Routing**
- A matrix (or per-row dropdowns) of data inputs × sound parameters. Each route has an
  on/off toggle and an **amount** slider (-100% to +100%, negative inverts the mapping).
- Several inputs may drive one parameter (amounts are summed, then clamped).
- "Reset to defaults" restores the table above.

**Per-route shaping**
- Input range (min/max) with an "auto" option that uses the station's historical range.
- Output range (e.g. filter cutoff 200 Hz-8 kHz).
- Curve: linear / exponential / logarithmic / stepped.
- Smoothing (slew) time, so jumps between 6-min readings glide instead of click.

**Musical settings**
- Root note and scale/mode (or "auto" = driven by `residual_pct`).
- Tempo, or "auto" from `rate`.
- Octave range for the arpeggio.
- Per-layer volume and mute/solo: pad, arpeggio, bells, texture, noise.
- Master volume, reverb mix.

**Time**
- Live (follows "now") vs. a replay speed (e.g. 1 hour of tide per 10 s) to hear a whole
  tide cycle quickly. Replay is good for the demo video.

**Feedback**
- Each control shows the live input value and the resulting parameter value, so the user
  can see the data change the music.
- Settings are saved in `localStorage` and can be shared as a URL (query string).
