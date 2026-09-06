# Griddle — a physically honest burger simulator

You get a ticket (rare, medium-rare, medium, medium-well or well done), you form a patty by hand,
and you cook it in a real pan on a real burner. Nothing in the viewport is animated on a timer:
the colour of every layer, the juice sweating out of the top, the fat pooling around the patty,
the sizzle, the steam, the spatter, the smoke and the crust are all read off a heat- and
mass-transfer model that runs at 40 Hz.

## Run it

It is plain HTML/JS. Three.js is vendored, so no build step and no network access is needed.

```
npm start            # serves the folder on http://localhost:8000
```

or open `index.html` from any static server. (Opening the file directly works in Firefox;
Chrome blocks texture canvases on `file://`, so use a server.)

```
npm test             # physics regression tests (node --test)
npm run calibrate    # prints time-series for a dozen cooking scenarios
```

## Controls

| Input | Effect |
|---|---|
| Left-drag | orbit / mouse look |
| Wheel, right-drag | zoom |
| Right-click | zoom onto the point under the cursor; right-click again to back out |
| Middle-drag / shift-drag | pan |
| `1` `2` `3` `4` | kitchen, overhead, side and close-up presets; `R` resets |
| `C` | cutaway: slice the patty in half and watch the inside cook |
| `Space` | lay the patty in, then flip; `F` flip, `P` press |

The **Inspector** button opens a live chart (pan, crust surface, bottom layer, centre, top) and a
table of everything the model knows. **Hard mode** hides the thermometers.

## What is actually simulated

**The patty** is a 1-D finite-difference stack through its thickness (about 0.6 mm per layer,
10–80 layers). Each layer carries temperature, bound water, solid / melted / free fat, protein,
and irreversible denaturation extents for myosin (~52 °C), collagen (~61 °C), actin (~68 °C) and
myoglobin (~64 °C, the pink-to-grey colour change). Heat capacity and conductivity are computed
from composition every step, with ice fusion handled by an apparent-cp method if you start from
frozen.

**Heat in** comes through a contact conductance from the pan that depends on oil film, whether
the underside is boiling, whether the crust has dried (dry crust insulates and makes poor
contact) and whether the patty has domed off the pan. Heat out goes to air by convection,
evaporation (Magnus vapour pressure) and radiation, plus edge losses.

**Water** boils at 100 °C with full latent heat, which is why the underside sits pinned at
100 °C and cannot brown until it has boiled dry. Capillary diffusion keeps wicking moisture
toward the crust. As proteins denature the matrix's water-holding capacity collapses, and the
freed juice migrates to the faces: it beads on top (the classic flip cue), boils at the pan,
or runs off the edge into the fat.

**Fat** melts at ~42 °C, is released from ruptured cells with a temperature-dependent rate, and
drains under gravity into the pan, where it becomes the pool you sear in — and smokes if the pan
is above ~250 °C.

**Surface chemistry** runs on an extrapolated true surface temperature. Maillard browning is an
effective Arrhenius rate gated by water activity; pyrolysis (char) is a second, steeper Arrhenius
rate. The crust index drives colour, mottling, char blotches, roughness and the "release" from the
pan: flip raw meat on stainless and it tears.

**The pan** is a lumped thermal mass (cast iron, carbon steel, stainless tri-ply or nonstick)
with burner input (gas, lagging electric coil, or induction), natural convection and radiation
losses, juice boil-off with a Leidenfrost regime, fond that browns and then burns, and spatter
that throws fat out of the pan when water flashes under it.

**Cheese** is a stack of lumped slices (each added slice rotated a little further) with heat
passing meat → slice → slice → air. The part of a slice hanging past the patty droops as it melts;
whatever reaches the pan becomes a skirt that boils dry into a lace, browns and burns. Flip a
cheeseburger and the cheese goes face-down onto the pan, fries, welds, and comes back up as lace.
Under deep-frying oil the whole slice fries.

**Oil** is a film until it covers the floor, then a level that rises up the wall: cover the patty
and it deep-fries (hot-oil convection on every face), pour past the rim and it spills, hit a live
burner and it flares. **The pan persists between tickets** with its heat, fat, fond, welded
cheese, torn crust and a carbon layer that builds when residue sits on a hot pan; dirt costs
contact and crust until you wash it (which also cools a hot pan under the tap). Gas, electric and
induction each have their own burner model and pan height, and the glass lid fogs with steam.

**Doneness** is judged on the *peak* centre temperature, including carry-over while resting.
Scoring: doneness 50, crust 20, juiciness 15, evenness (grey band) 10, structure 5. At service
the patty goes on a sesame bun; juice that ran out during the rest soaks the bottom bun.

## Cooking a 100

The score is doneness 50, crust 20, juiciness 15, evenness 10, structure 5. Doneness is the peak
centre temperature after resting, so cook with the probe and pull early: carry-over on a 150 g
patty is 6–9 °C. A perfect score is reachable for every ticket with ordinary good technique.
The recipe that does it, found by `node test/player.js` and confirmed through the UI:

- 150 g, 80/20, straight from the fridge, thumb dimple, salt on the surface, handling ~35.
- 18 mm for rare and medium-rare, 14 mm for medium and above.
- Cast iron on gas: preheat on 8 until the IR gun reads ~200 °C, then hold around 4.5.
  8 g of canola, then lay the patty in and insert the probe at 50 % depth.
- Flip every 45 s (the meat releases on its own once the underside has dried).
- Pull when the probe reads: rare 41, medium-rare 46, medium 54, medium-well 61, well done 67 °C.
- Rest 2–2.5 minutes, then serve. Never press it.

Smashing, a screaming-hot pan, a single flip on a thick patty, or cutting it straight off the
heat will all cost you somewhere, and the results screen says where.

## Layout

```
index.html         page and HUD
css/style.css
js/physics.js      the model (also loads in Node; see test/)
js/render3d.js     Three.js scene, patty geometry, textures, particles, camera controls
js/audio.js        procedural sizzle, spatter, burner hum
js/game.js         phases, UI, loop
js/vendor/three.min.js   r128
test/physics.test.js     regression tests
test/calibrate.js        scenario runner used to tune the constants
```
