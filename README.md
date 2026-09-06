# Griddle — a physically honest burger simulator

You get a ticket — one to three burgers, each ordered rare, medium-rare, medium, medium-well or
well done — you form each patty by hand, and you cook them together in a real pan on a real
burner, so that they all land on the plate hot at the same time. Nothing in the viewport is animated on a timer:
the colour of every layer, the juice sweating out of the top, the fat pooling around the patty,
the sizzle, the steam, the spatter, the smoke and the crust are all read off a heat- and
mass-transfer model that runs at 20 Hz, and at up to eight times real speed when you are waiting
for a pan to come up to temperature.

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
npm run perf         # how many milliseconds of CPU a simulated second costs
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
| `Tab`, click a patty, or the chips under the ticket | select which patty the buttons act on |
| Stove: charcoal kettle | the knob becomes the vents, the pan goes away, and the lid is the kettle's |

The **Inspector** button opens a live chart (pan, crust surface, bottom layer, centre, top) and a
table of everything the model knows. **Hard mode** hides the thermometers.

## What is actually simulated

**The patty** is a 2-D axisymmetric finite-difference grid: 10–60 layers through its thickness
(about 0.6 mm each) by 6–16 concentric rings (about 4 mm each), so the rim and the middle are
different places. Each cell carries temperature, bound water, solid / melted / free fat, protein,
the hottest it has ever been, and irreversible denaturation extents for myosin (~52 °C), collagen
(~61 °C), actin (~68 °C) and myoglobin (~64 °C, the pink-to-grey colour change). Heat capacity
and conductivity are computed from composition every step, with ice fusion handled by an
apparent-cp method if you start from frozen. The edge cooks from the side as well as from below,
dries out first and browns darkest; the crust is tracked ring by ring on both faces, so a domed
patty gets a pale lifted centre and a dark rim, and the cut face shows the real map.

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

**The pan** is twelve concentric rings of metal (cast iron, carbon steel, stainless tri-ply or
nonstick) conducting radially through their thickness, so a burner makes a hot spot: on gas the
centre runs 60–100 °C hotter than the rim, induction heats an annulus, a thin pan shows more of
the burner's shape than a thick one. Each patty draws heat from the rings under it and a cold
patty pulls those rings down — crowd three into one pan and the metal sags by 30–50 °C and takes
a minute to recover. Burner models for gas, a lagging electric coil and induction; natural
convection and radiation losses from the uncovered metal; juice boil-off with a Leidenfrost
regime; fond that browns and then burns; spatter that throws fat out of the pan when water
flashes under it.

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
Scoring: doneness 50, crust 20, juiciness 15, evenness (grey band) 10, structure 5. The grey
band is the volume of meat whose peak temperature went a whole doneness step past the order.
At service the patty goes on a sesame bun; juice that ran out during the rest soaks the bottom
bun.

**The charcoal kettle** replaces the pan with a steel grate over 1.5 kg of lump charcoal. The
knob is the vents: airflow sets the temperature the bed heads for (~350 °C banked, ~750 °C wide
open, with the lid throttling it) and how fast the coals burn down to ash. The grate is thin bars
heated by the bed's radiation and the hot gas coming up through it. A patty over the coals gets
bar contact on about a quarter of its face — hotter lines that brand grill marks with their own
browning and char — and radiation plus hot gas on the rest, with radiant heat browning the edge
too; its crust settles well above a pan's temperature, so it sears faster and chars sooner. Juice
falls through the grate and fat lands on the coals: a steady drip is a small licking flame, a
rush (press it, or a 70/30 blend) is a flare-up that raises the radiant load, soots the underside
and the edge, and dies back in seconds. The lid turns the kettle into an oven: hot dome air and
the dome's radiation cook and brown the top face while the coals calm down. Grilled patties are
judged with the grill in mind (more juice is lost through the grate, the edge cooks from the
side), and the bars' marks count as crust.

**Speed and the timestep.** The model steps at 0.05 s of simulated time (20 Hz). That is a long
way inside the stability limit of the explicit conduction — 0.6 mm layers of meat allow about
0.6 s, twelve rings of cast iron about 1.7 s — and the patty automatically sub-cycles its
conduction if you smash it thin enough to need it. Stepping at 0.025 s instead moves the peak
centre temperature by less than 0.2 °C and the cook times by under two seconds, which is why the
regression tests still run at 0.025 s: the constants were calibrated there. One simulated second
of one patty in a pan costs about 2.7 ms of CPU at 0.025 s and 1.4 ms at the game's 0.05 s, so
three burgers at 8× speed take under half a millisecond of physics per frame; `node test/perf.js`
prints the numbers for a pan, a crowded pan, the charcoal grill and a full five-minute cook.

**Tickets with several burgers** share the pan. Each patty is formed separately (a well-done
wants a thinner patty than a rare), laid in at its own spot, flipped, pressed, cheesed and pulled
on its own, and each is scored against its own order. The ticket score is the mean, less a
service penalty for any burger that went out lukewarm because it sat on the plate while the
others were still cooking: a rested patty cools in the air, and a centre that has fallen more
than ~8 °C from its peak is noticeably cooler on the tongue. Start the one that needs longest
first.

## Cooking a 100

The score is doneness 50, crust 20, juiciness 15, evenness 10, structure 5. Doneness is the peak
centre temperature after resting, so cook with the probe and pull early: carry-over on a 150 g
patty is 4–9 °C (more on a thick one, less on a thin one that has been flipped often). A perfect score is reachable for every ticket with ordinary good technique.
The recipe that does it, found by `node test/player.js` and confirmed through the UI:

- 150 g, 80/20, straight from the fridge, thumb dimple, salt on the surface, handling ~35.
- 18 mm for rare and medium-rare, 14 mm for medium and above.
- Cast iron on gas: preheat on 8 until the IR gun reads ~200 °C, then turn it down to hold
  there (around 4–5 on the knob; watch the IR gun and nudge it, the pan drifts).
  8 g of canola, then lay the patty in and insert the probe at 50 % depth.
- Flip every 45 s (the meat releases on its own once the underside has dried).
- Pull when the probe reads: rare 41, medium-rare 47, medium 56, medium-well 61, well done 68 °C.
- Rest 2–2.5 minutes, then serve. Never press it.

Smashing, a screaming-hot pan, a single flip on a thick patty, or cutting it straight off the
heat will all cost you somewhere, and the results screen says where.

On the charcoal kettle the window is narrower, but it is there: light it on 8, wait for the
bed to glow and the grate to pass 250 °C, then run the vents on 7 (bed around 630 °C). An 18 mm
patty flipped every 45 s and pulled at 47 °C lands a medium-rare 100 with bars branded into
both faces. Vents wide open, a thick patty and lazy flips is a charred one.

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
test/perf.js             benchmark: milliseconds of CPU per simulated second
```
