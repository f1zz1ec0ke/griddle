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
npm test             # the physics regression suite (node's test runner, sharded across workers)
npm run test:serial  # the same tests in one process: node --test test/physics.test.js
npm run e2e          # end-to-end: plays real tickets in a real browser (see below)
npm run calibrate    # prints time series for a couple of dozen cooking scenarios, pan and kettle
npm run perf         # how many milliseconds of CPU a simulated second costs
npm run player       # sweeps recipes looking for a 100; `npm run player -- grill quick` for the kettle
```

`npm test` reads the test names out of `test/physics.test.js`, deals them round-robin into
`min(4, cores)` worker processes and runs each worker with `--test-name-pattern`, because the suite
is several hundred simulated minutes of cooking and node runs the tests in a file one at a time. It
refuses to report a pass unless the shards add up to every test in the file — it reads them at any
indentation, and refuses to run at all if it finds a test whose name is a template it could never
match, or if its two independent scans of the file disagree. `TEST_WORKERS=1` makes it serial and
`node test/run.js <substring>` runs the tests whose names contain that substring.

`TEST_TIMEOUT` (ms, default 600000) is **one worker's budget for its whole shard**.
A parent-process watchdog terminates an overdue worker even when its test is synchronous.
Workers execute the test file directly, avoiding an extra child process and differences in
Node's built-in file-timeout behavior. The runner reports the last completed test and refuses
to pass an incomplete shard. Regression tests check both asynchronous and synchronous hangs.
After the physics shards, `npm test` runs the session and gameplay regression tests.
CI runs the suite on Node 22 and Node 24 for every push and pull request.

## Practice, sessions and burger builds

**Free practice** starts an untimed kitchen with no tickets, customers or scores. Form up to four
patties at once, add toppings, and experiment with the same simulation used in service.
**Form another patty** adds food to the existing kitchen; **Clear food** empties the bench while
preserving stove heat and residue, and lets you change equipment. No tutorial is required.

Service tickets now specify a build for each burger as well as its doneness. The order card and
cooking panel list the requested bun halves, cheese, bacon, egg or onions. A check mark means an
ingredient is assigned, not that it is cooked: its quality still matters. Assign toppings to the
correct burger using the existing assignment controls. Bun halves move together. Missing a
requested ingredient sends that burger back; extra toppings remain allowed. Tickets with builds
allow additional time, especially for onions.

**Back on the heat** returns resting meat or toppings to the pan. Cooking damage, temperatures
and previous peak temperature are preserved; reheating cannot undo overcooking. Check the burner
or vents when returning from rest. **Discard** removes the selected topping (both halves for a
bun), so a replacement can be cooked and assigned normally. Practice also lets you discard meat.

**Pause** freezes the simulation and ticket clock. Opening Help also freezes cooking and blocks
background actions; Escape closes Help. **Save** stores the current kitchen, food, forms, ticket
and shift in this browser. Active sessions also autosave every 15 seconds and on leaving the page.
Service and practice have separate save slots; **Resume saved service/practice** restores one
paused, with no offline cooking. The status next to Save reports storage failures. Saves are local
to this browser and site address; clearing browser storage removes them. Camera position is not saved.

The interface is designed for desktop use (1024 px or wider). A floating station overlays the
full-width 3D kitchen, with instruments at the bottom and food selection above. The Kitchen menu holds
save/resume, camera, inspector and sound controls. Equipment, cleaning tools and the log expand
when needed. Phone layouts are not supported. Hard mode still hides thermometers.

### End-to-end

`test/e2e/` plays whole tickets through the actual page in headless Chromium: it serves the folder
on a free port, clicks the real buttons, drags the real sliders, screenshots what it sees into
`test/e2e/out/` (gitignored) and fails on a single uncaught page error. Six scenarios:

| `npm run e2e -- <name>` | what it plays |
|---|---|
| `medium-rare` | the README recipe end to end; it has to come out 100/100 |
| `ticket-of-three` | three burgers in one pan, staggered, each pulled at its own temperature |
| `charcoal` | swapping the pan for the kettle mid-ticket, lighting it, the lid, and a flare-up |
| `shift` | six tickets on one pan, one of them sent back, and the end-of-shift card that has to add up |
| `viewport` | the renderer gives its memory back and draws what the model says is there |
| `interface` | hard mode keeps its promise, the keys work, and the panel survives a small window |

Playwright is not a dependency of this repo (there is no build step and no `node_modules`); it is
expected to be installed globally, so run the scenarios with `NODE_PATH` pointing at it:

```
NODE_PATH=/opt/node22/lib/node_modules npm run e2e            # all of them
NODE_PATH=/opt/node22/lib/node_modules npm run e2e -- charcoal   # just one
```

(`PLAYWRIGHT_PATH=/somewhere/lib/node_modules` works too.) Chromium is launched with
`--use-gl=swiftshader --enable-webgl --ignore-gpu-blocklist --enable-unsafe-swiftshader` at
1400×860, so the WebGL viewport really renders. That software rasterising, not the physics, is what
makes a scenario take five to fifteen minutes: the simulation is fast-forwarded, but every step the
runner takes waits on a frame, and a pan with three patties in it is three sets of textures.

## Controls

| Input | Effect |
|---|---|
| Left-drag | orbit / mouse look — unless you start on a patty, in which case you drag it across the pan |
| Drag a patty | slide it to another part of the pan or grate; a ring shows where it will land (red if something is in the way). **Move to centre / Move to edge** do the same from the keyboard |
| `S` | scrape: work the spatula under a patty that has welded itself to the metal |
| Wheel, right-drag | zoom |
| Right-click | zoom onto the point under the cursor; right-click again to back out |
| Middle-drag / shift-drag | pan |
| `1` `2` `3` `4` | kitchen, overhead, side and close-up presets; `R` resets |
| `C` | cutaway: slice the patty in half and watch the inside cook |
| `Space` | lay the patty in, then flip; `F` flip, `P` press |
| `T` | press test: put a finger on it and feel how far it has gone |
| `K` | peek: cut into it and look at the colour and the grey band |
| `H` | hold a hand over the pan or the grate and count the seconds |
| `[` / `]`, click a patty or topping, or the chips under the ticket | select what the buttons act on; Tab moves keyboard focus normally |
| **Extras** row | put bun halves, bacon, an egg or sliced onions in the pan beside the patties |
| `F` with a topping selected | turn the bun / rasher / egg — or stir the onions |
| Stove: charcoal kettle | the knob becomes the bottom vent, the pan goes away, and the lid is the kettle's |
| **Bank coals** (kettle only) | rake the bed to one side: a searing zone over the coals and a gentle one off them |
| **Lid vent** (kettle only) | the damper in the lid: the other half of the airflow when the lid is on, and the way the smoke gets out |
| **Add wood** (kettle only) | a 60 g chunk of hickory, apple or mesquite on the coals — smoke for a quarter of an hour |
| **Add coals**, **Stir**, **Empty ash** | more lump charcoal (cold, so the bed dips first), rake the ash off the bed, tip the bowl out when it is cold |
| HUD ticket clock | time on this ticket against the time the table was quoted — amber over, red at double |

The **Inspector** button opens a live chart (pan, crust surface, bottom layer, centre, top) and a
table of everything the model knows. **Hard mode** takes the probe and the IR gun away entirely and
leaves you with what a cook actually has: the **Senses** row — press test, peek, hand over the pan —
your eyes, and your ears. It holds all the way through: the Inspector is gone, the log's
temperatures read `·· °C`, and the results card tells you what the burger came out as in words
(“it came out raw / blue”) without the number or the two temperature traces. The buttons are there in normal mode too, because a real cook uses them
even when the numbers are on the wall, and they cost exactly the same either way.

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

**Where it sits** is part of the cook, and it can be changed: drag a patty and it slides across the
metal. The rings it draws heat from, the part of the burner's profile under it and the fraction of
each ring it shades all follow it on the next step — a patty's own ring is a circle, so the metal
under that ring is averaged around it rather than read at one radius, and the heat the meat takes
goes back into exactly the rings it came out of. Meat welds itself to hot metal and only lets go
once its crust has set and dried, so sliding a patty before then tears the bottom face off exactly
as an early flip would; the strips stay on the pan as fond. **Scrape** works a thin blade under it
first: a steel edge breaks a half-set crust a strip at a time instead of ripping the whole face at
once, which costs about 40 % of the tearing — and a second of searing, because for that second most
of the face is up on the blade rather than on the metal. On a patty that has already released it
just confirms that it slides.

**Cheese** is a stack of lumped slices (each added slice rotated a little further) with heat
passing meat → slice → slice → air. The part of a slice hanging past the patty droops as it melts;
whatever reaches the pan becomes a skirt that boils dry into a lace, browns and burns. Flip a
cheeseburger and the cheese goes face-down onto the pan, fries, welds, and comes back up as lace —
and the metal pays for it: the rings under the patty are charged what the pan put into the *bottom*
of the slice stack, not the smaller flux that gets through to the meat, so warming 20–40 g of cheese
and boiling the water out of it sags the pan by tens of degrees the way it should.
Under deep-frying oil the whole slice fries.

**Oil** is a film until it covers the floor, then a level that rises up the wall: cover the patty
and it deep-fries (hot-oil convection on every face), pour past the rim and it spills, hit a live
burner and it flares. **The pan persists between tickets** with its heat, fat, fond, welded
cheese, torn crust and a carbon layer that builds when residue sits on a hot pan; dirt costs
contact and crust until you wash it (which also cools a hot pan under the tap). Gas, electric and
induction each have their own burner model and pan height, and the glass lid fogs with steam.

**The cook's own instruments** are derived from the same grid as everything else, and each costs
what it costs in a real kitchen.

A **press test** is stiffness. Raw mince is a wet paste at about 8 kPa; myosin gelling at 52–58 °C
turns it into a solid, collagen shrinking at 60–67 °C squeezes the fibres (over hours it would
dissolve into gelatin and soften them again, but a burger is on the pan for five minutes, so here it
only ever toughens), actin at 66–73 °C makes it hard, and drying stiffens everything — a boiled-dry
crust is leather at 60–80 kPa, eight or nine times raw mince. Through the thickness those layers are springs in series, so it is the
*compliances* that add and the softest layer dominates what the finger feels: a raw centre still
feels soft under a set crust, which is the entire reason the test works. Across the patty the columns
add as stiffnesses, weighted by a Gaussian the width of the fingertip plus half the thickness,
because the load spreads at about 45° as it goes down. The index runs 0 (raw) to 1 (well done), and
the words are the ones a hand learns: slack, soft, springy, firm with give, firm, hard. It is not
free — a fingertip at a few kPa over a couple of square centimetres squeezes about half the free
juice out of the meat directly under it, which over the footprint is a tenth of what leaning on the
whole face with a spatula costs — and it is a second and a bit with your hand over a hot pan.

A **peek** is a knife through it. You see the colour at the centre (read off the myoglobin and myosin
extents down the axis, the same numbers the renderer paints the cut face from) and how many
millimetres of grey band have come in from each face. The viewport shows you the real cutaway for a
few seconds at whatever angle the knife went in, and then the slit stays as a line on both faces.
The cut opens 2·D·h of new surface against the 2πR² + πDh the patty had — about a sixth of it, all
open fibre ends at the plane the free juice is migrating through — so from then on a sixth of
everything the matrix lets go of runs out of the cut instead of pooling on a face and going back into
the burger. That is a couple of percent of the water over a rest, and a quarter of the structure
mark. A patty that has been cut into cannot score 100.

The **hand test** is the oldest thermometer there is: a palm about 8 cm over the metal, counting.
The flux at the hand is radiation from whatever fills its view — the pan floor, or over a kettle the
bars plus the ash-skinned bed seen through the gaps between them, with the view factors done as
R²/(R²+z²) — plus convection from the plume. How long skin takes that is the Stoll second-degree-burn
correlation, t ≈ 121·q^−1.35 with q in kW/m², which is the moment one more second would do damage
and so the moment a hand comes away. Wide-open vents put 25 kW/m² on it and you get 1.6 seconds; over a
banked bed it is about 2 seconds over the coals and 12 off them; a 200 °C pan gives you 21 seconds,
because a pan is not a fire and the classic 2/4/6/8-second chart is a grill technique. On a pan the
number still moves where it matters — 21 s at 200 °C, 13 at 250, 9 at 300, 6 at 360 (measured over
cast iron preheated on gas, so with a hot centre; a pan that is 200 °C edge to edge reads 27) — and
the word that goes with the count is on a pan scale over a pan: twenty seconds is *medium*, "about
right under a patty", while eight seconds, which is *medium* over coals, is *searing* over a pan,
because it means metal past every oil's smoke point. Over a banked kettle with nothing on the bars
the hand goes over each side in turn and reports both.

**Listen to it.** The sizzle has two voices and they mean different things. Water flashing out of the
face against the metal is a low, loud, rough crackle at 1–2 kHz, hard amplitude-modulated by
bubbles collapsing; the moment that face has boiled dry it stops, and what is left is fat at 180 °C
on hot metal — quiet, 5–7 kHz, steady, with sparse bright pops. That transition is the crust
starting, and it is audible a long time before it is visible. The kettle adds a low roar that follows
the vents and a whoosh when fat lights on the coals; a lid low-passes everything at 800 Hz and drops
it 5 dB; and a patty lifted on the blade takes its sizzle with it. The same features are written into
the log in words, so hard mode has the cue even with the sound off.

**Doneness** is judged on the *peak* centre temperature, including carry-over while resting.
Scoring: doneness 50, crust 20, juiciness 15, evenness (grey band) 10, structure 5. The grey
band is the volume of meat whose peak temperature went a whole doneness step past the order.
At service the patty goes on a sesame bun; juice that ran out during the rest soaks the bottom
bun.

**Toppings** share the pan with the meat. Two **bun halves** go in cut side down, a rasher of
**bacon**, an **egg**, or 80 g of sliced **onions** — each takes a spot on the metal (they never
land on top of each other unless the pan is genuinely full), draws heat out of the rings under its
own footprint, and shades that metal from the room exactly as a patty does. Each is two or three
lumped nodes rather than a grid, because none of them is thick enough for a profile through it to
be worth solving, but every node carries its own water and boils at 100 °C with full latent heat,
which is what makes them take the time they take.

A **bun face** is dry starch on hot metal: it drinks a few grams of the pan's fat, the crumb behind
the crust keeps wicking water forward into the drying front (which is why toast takes a minute and
not ten seconds), and then it browns on the same Maillard kinetics the meat uses — roughly twice as
fast, because the dough's maltose and free amino acids are already there. Over 200 °C metal that is
golden in about a minute and black in three. Turn it over and the crown just scorches: its sugars
went in the oven. A toasted heel is a sealed crust, and it soaks up about 60 % less of the juice
that runs out during the rest. **Bacon** renders with the patty's own melt-and-release kinetics
(faster: the fat is in continuous bands, not locked in cells), but only the fat in the bands between
the muscle can ever leave: a rasher gives up 50–65 % of its fat and 60–70 % of its water and comes
off the pan at a little under half its raw weight, still about 40 % fat, which is what cooked
streaky bacon is. It shrinks by a quarter, curls away from whichever face has dried and contracted
more, and only goes crisp once the lean is dry *and* the fat it is going to give up is out — eight
minutes at 180 °C (that is the metal under the rasher; the centre of a pan preheated wide open runs
40 K over the IR gun's area mean), or black in three at 260. An **egg** is a bottom white, a top white and a yolk: the white sets at 62–65 °C from the pan up (the
top of it is still soft at a minute and set by two), the yolk thickens from 65 and is solid by 70,
and because the yolk sets from the skin inward, sunny side up leaves it runny for about three
minutes (measured on a 160–200 °C pan: jammy at 3:15, hard ten seconds later). A gelled white is not a puddle any more — it blisters and rides off the metal, so the
contact collapses to under a third of the raw white's and the water left in it is held in the
protein: a fried egg loses 10–15 % of its mass, not a third of it. A lid changes that in about eighty seconds — saturated air
condensing on a cold yolk is worth far more than the convection — and turning the egg over puts the
yolk a millimetre of white off the metal, which is over-easy at once and jammy half a minute later.
The jammy window is narrow either way: the yolk goes from thickened to crumbly in four to seven
seconds, so it is a thing you watch, not a thing you time.
The rim that ran out into the fat dries and browns into a lace. **Onions** are 89 % water and the
whole model is that water: the layer against the metal boils, the pile above re-wets it as fast as
juice can drain down through a heap of slices, and until that stops the onions sweat at 100 °C and
nothing browns — that is sweated onion, soft and translucent and mild, and it is what most of the
onions on most burgers are. Fifteen minutes on medium and the pile runs dry, the contact layer
decouples from the wet mass above it, and the sugars caramelise — golden, brown, and then bitter. An
onion carries only 5.6 % of its weight as free sugar, so the layer on the metal can only go so dark
before it runs out and starts to pyrolyse instead; stirring is not fussiness, it is what brings
unspent onion down onto the metal, and it is the only way to caramelise all of them rather than burn
a third of them. On a 260 °C pan the drying front wins in two minutes and that layer scorches. They
also lift the fond off the metal as they go.

Anything lying on the metal is a thing the pan is heating and a thing the pan can hear: toppings
count in the coverage, in the heat drawn out of the rings under them, and in both voices of the
sizzle, so a pan with nothing in it but two rashers rendering still sounds like a pan with bacon in
it. If there is nowhere clear to put something down it goes half on top of what is already there —
the game says so — and only the part actually touching the metal cooks.

At service each topping is **built onto a burger** — the chips and the *Build onto* row show which,
including the default (`→ (2)`, a dashed outline) before the plate goes out, so a build can be
changed while there is still time. A bun's two halves always travel together: the pair goes wherever
the heel goes, or wherever either half was put by hand. The patty's own score
never moves: the build is a separate service penalty of up to ten points on the ticket for anything
sent out raw or burnt — a raw egg white, limp bacon, a black bun, scorched onions — and a couple of
points back for a jammy yolk, crisp bacon, sweet onions or a properly toasted bun.

**The charcoal kettle** replaces the pan with a steel grate over 1.5 kg of lump charcoal. The
knob is the bottom vent: airflow sets the temperature the bed heads for (~350 °C shut down,
~750 °C wide open, with the lid throttling it) and how fast the coals burn down to ash. The grate is thin bars
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

**Banking the coals** rakes the bed to one side. It moves the charcoal, it does not change how much
of it is burning: the same mass, twice as deep over half the grate, bare ash under the other half.
What that changes is what a point over the grate *sees*. Over the pile it is glowing coal filling
its view and the fire's own gas coming up through the bars. Over the bare half it is ash and the
enamel of the bowl — warmed by the pile, but radiating at three quarters of its temperature through
about a third of the view factor, with gas that has crossed the kettle and mixed with room air on
the way. The bars answer accordingly: the grate is still solved as rings (that is where its heat
capacity and everything the meat draws out of it live), with the two-zone difference carried as a
zero-mean departure across the bank axis, each strip a thin bar in balance with the fire under it
and conducting along the bars to its neighbours. 4 mm of steel is about 13 kJ/(m²K), so a strip on
its own would settle in a couple of minutes — but it is conducting into its neighbours on a ~100 s
time constant and the bed under it is still moving, so the split is only about half there at two
minutes and takes eight to ten to stop: 53, 92, 121, 142 K at one-minute marks and 188 K in the end
at vents 7; 228 K at vents 9. Settled, that is **180–230 °C between the two sides**,
and about a sixth of the radiant load (0.36 of the view factor at 0.75 of the bed's rise over
ambient, and radiation goes as T⁴). A patty reads the fire at its own position — bottom boundary,
crust temperature cap, edge radiation and flare-ups included, because a flare burns where the fat
lands, not over bare ash. Sear over the coals, slide it across, and finish it gently.

**Wood, and the smoke that is the point of a fire.** A chunk is ~60 g of split hardwood: 700 kg/m³
air-dried to about 12 % moisture, so a 4.4 cm block with 0.012 m² of surface for the fire to work
on. It does nothing at all for the first three minutes — the bed has to boil 7 g of water out of it
(pinned at 100 °C, full latent heat, like everything else in here) and then take it to pyrolysis
temperature, about 300 °C, which on a 610 °C bed takes 3:11 and on a 680 °C one 2:32 — and then it
smoulders for fifteen to seventeen minutes. The rate follows the
remaining surface, m^⅔, because a smouldering front lives on a surface: the smoke peaks a couple of
minutes after the chunk is alight and decays as it is eaten away. Pyrolysis is endothermic
(~400 kJ/kg), which is what holds a smouldering chunk in the 350–450 °C band instead of running away
to the bed's temperature, and what is left at the end is charcoal, which joins the bed as fuel.

Whether that smoke is worth eating is entirely a question of air. With the vents open the volatiles
ignite as they leave the wood and what escapes is thin and blue — a few per cent of the mass as
phenols and guaiacols, and that is the flavour. Smothered, they never ignite, come off cool, and
condense on everything above them as thick white smoke: that is creosote, and it is bitter. The
smoke under the dome is solved as a stirred tank, one per kind of wood, dC/dt = (S − C·Q)/V: V is
the ~30 litres over the grate, and Q is what carries it away — the plume off an open kettle (fast,
so most of the smoke never touches the meat) or what the vents draw through a closed one, which is
what puts smoke over the food in the first place. Shut the top vent and Q collapses to the leak past
the lid, the concentration goes up twentyfold, and the meat is sitting in it. It lands on the meat at
a couple of millimetres a second — impaction plus thermophoresis onto a surface cooler than the gas
— and better while that surface is still cool and wet, which is why smoke goes into meat early and
stops mattering once the crust has dried, and it saturates, because past a few tenths of a gram per
square metre the smoke is landing on tar. **A moderate deposit is worth up to three of the twenty
crust marks** and can never take a crust that has already earned twenty above it; creosote is a
straight penalty of up to six. Mesquite smokes half again as hard as hickory, apple two thirds as
hard.

**Two vents in series.** With the lid off the bottom vent is the only vent. With the lid on the two
are orifices in series and the flows add as 1/A² = 1/A₁² + 1/A₂², i.e. A = A₁A₂/√(A₁²+A₂²) — a
smooth minimum, so shutting either one shuts the fire down and opening one wide does not rescue the
other. Both wide gives 0.77 of an open kettle — 0.71 for the two orifices in series plus the 6 % that
leaks past a lid that never quite seats, which is about what a lid costs; both shut leaves that 6 %
on its own, and the bed sags a couple of hundred degrees over
five minutes rather than going out in seconds.

**Ash, and the bed as something you keep.** Lump charcoal is ~6 % mineral ash by mass. Half of it
falls through the fire into the bowl and half stays up in the bed blanketing the lumps, and what
matters is how much there is *relative to the coal left*, not its absolute mass — so a fresh deep
bed swallows its own ash for a long time and a half-spent one is strangled by it. Ash at a tenth of
the bed's mass takes nearly half the draught away, which makes the fire both cooler and slower.
**Stir** rakes it through: the ash drops into the bowl, fresh incandescent surface comes up, and the
bed draws harder for about a minute and a half before settling. **Empty ash** tips the bowl, and only
when the kettle is cold, because live ash in a bin is how sheds burn down. **Add coals** tips in more
lump straight from the bag, and it is cold: 0.5 kg from room temperature to ignition at ~350 °C is
140 kJ, which is nearly a minute of the fire's entire output, so the bed drops 80–90 °C over the
first two minutes, the new lumps catch at four or five, and only then does the bed come back up —
past where it was, because a deeper bed has more incandescent surface for the same draught. Add
coals before you need them, not when the fire is already dying. And **the kettle persists between
tickets** exactly as the pan does: the coals go on burning down while the next patty is being formed,
the ash goes on building, the bars keep their heat and whatever is welded to them, and a chunk that
is still smouldering is still smouldering.

**Speed and the timestep.** The model steps at 0.05 s of simulated time (20 Hz). That is a long
way inside the stability limit of the explicit conduction — 0.6 mm layers of meat allow about
0.6 s, twelve rings of cast iron about 1.7 s — and the patty automatically sub-cycles its
conduction if you smash it thin enough to need it. Stepping at 0.025 s instead moves the peak
centre temperature by less than 0.2 °C and the cook times by under two seconds, which is why the
regression tests still run at 0.025 s: the constants were calibrated there. One simulated second
of one patty in a pan costs about 2.7 ms of CPU at 0.025 s and 1.4 ms at the game's 0.05 s, so
three burgers at 8× speed take under half a millisecond of physics per frame; `node test/perf.js`
prints the numbers for a pan, a crowded pan, the charcoal grill and a full five-minute cook. A
topping is lumped, so it costs about 0.2 ms per simulated second — a tenth of a patty — and a pan
with everything in it is still comfortably inside a frame.

**Cheese on the kettle** is a different animal from cheese in a pan. There is no metal under the
overhang, so once the slice is molten the part hanging past the meat sags between the bars and drops
on the coals in gobs of about a gram — each one a flare of burning milk fat — and the slice pulls
back over the patty until nothing hangs over any more. That is why cheese goes on late over
charcoal, and why the lid is the tool for melting it: the dome radiates onto the slice as well as
blowing hot air over it, and melts it in half the time. Pressing on a grate is only ever a press:
there is no flat surface to smash against, so the meat squeezes down between the bars and the juice
and fat you drove out of it land on the fire. And the wash button becomes a wire brush — the
residue comes off, the bars stay hot, nothing gets wet.

**When the numbers misbehave** the solver notices. Explicit finite differences on a grid that gets
re-formed under your hands (a smash halves the layer thickness, a flip reverses every column) can
in principle run away, so every patty keeps a snapshot of its last good step: if any cell comes back
non-finite the patty is rolled back, the step is taken again in eight pieces, an event goes in the
log, and the cook carries on. The pan's rings are guarded the same way. On an ordinary cook it never
fires; `s.guard` counts the times it did.

**Tickets with several burgers** share the pan. Each patty is formed separately (a well-done
wants a thinner patty than a rare), laid in at its own spot, flipped, pressed, cheesed and pulled
on its own, and each is scored against its own order. The ticket score is the mean, less a
service penalty for any burger that went out lukewarm because it sat on the plate while the
others were still cooking: a rested patty cools in the air, and a centre that has fallen more
than ~8 °C from its peak is noticeably cooler on the tongue. Start the one that needs longest
first.

**The customer** does not read the rubric. When the plates go out, whoever ordered them says what
they think in their own words — "it's dry", "there's no crust on it at all", "it's cold in the
middle", "that isn't medium, that's uncooked" — built out of the same numbers the score is: how far
the peak centre landed from the band, how much of its water the patty still has against what that
doneness should hold, the browning index and char on each face, how far the middle fell from its
peak while the plate waited, whether the crust tore or the patty domed, and what the charcoal and
any flare-up left on it. Each plate is **sent back** (under 45, or anything raw or burnt on the
build), **accepted**, or the customer is **delighted** (90 or more), and they tip on the bill —
$14 a burger, $1.50 a slice of cheese — nothing on a plate that goes back, about 10 % on a
mediocre one, 20 % on a good one and 25 % on a perfect one. A late or lukewarm plate is tipped like
a worse one. The phrasing is picked deterministically from the patty and its score, so the same
burger always says the same thing and the next one does not.

**A shift is six tickets.** Each one carries a target time from the moment you say "yes chef":
roughly 1.6× the recipe — the longest burger on the ticket, plus 40 % of each of the others (they
share the pan, but a crowded pan sags and every patty is formed by hand), plus the rest — so one
medium-rare is quoted at 13:10 and a three-top somewhere between 20:00 and 24:00 depending on what
is on it (rare, medium and medium-well is 20:00; medium-rare, medium-well and well-done is 23:50). The HUD ticket shows the clock against it
("7:40 / 13:10"); the clock runs in kitchen time, so speeding the simulation up does not buy you
service time. Going over costs up to 10 ticket points at twice the quote, and the table says so.
A ticket with a plate sent back scores nothing for the shift, and service moves on. At the end you
get the night's card — covers, average, best and worst ticket with what those tables said, tips,
time on the line — and the best shift is kept in the browser.

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
heat will all cost you somewhere, and the results screen says where — first in the customer's
words, then in the bars. A 100 is delighted and tips the full 25 %; get all six tickets out inside
their quoted times and the shift card has nothing to complain about.

In **hard mode** the same recipe is reachable without a single number. Preheat until a hand over the
pan gives you about twenty seconds and the note says *medium* (that is a 200–220 °C pan; the grill
chart does not apply over a pan — nine seconds over cast iron is 300 °C and a black crust), lay it
in, and wait for the loud crackle to
drop to a hiss before you flip — that is the underside telling you it has dried and browned. Press
it: soft with a spring is rare, springy is medium-rare, firm with a little give is medium. Pull it
one step *under* the order, because carry-over is still coming, and rest it. Peeking will tell you
the truth and cost you a point of structure and a couple of percent of the juice, so peek on the one
you are least sure about, not on all three. The results screen counts the cuts and the presses.

Toppings are scored separately and can only cost you the ticket, never the patty. If you put them
in: the buns want about a minute face-down on 200 °C metal (watch the browning index in the
inspector — 1.2 is toasted, 4.5 is too far, and char over 0.35 is a black bun); bacon wants eight
minutes at 180 °C with a couple of turns, not four at 260 (it comes off at a little under half its
raw weight — that is what crisp bacon weighs, not a fifth); an egg wants the lid on for about eighty
seconds, or a flip and thirty, for the jammy yolk — and the window is only a few seconds wide, so
watch the yolk rather than the clock (ninety under the lid is already hard); onions want a quarter of an hour on
medium with a stir every minute or two, and they will drag the pan down 20 °C while they sweat, so
start them before the meat. Take each one off when it is right — a topping left in the pan keeps
cooking — and use the **Build onto** buttons to say which burger it belongs to.

On the charcoal kettle the window is narrower, but it is there: light it on 8, wait for the
bed to glow and the grate to pass 250 °C, then run the bottom vent on 7 (bed around 630 °C). An
18 mm patty flipped every 45 s and pulled at 47 °C lands a medium-rare 100 with bars branded into
both faces. Vents wide open, a thick patty and lazy flips is a charred one — `node test/player.js
grill quick medium-rare` sweeps the vents and reports the same window (6 to 7; 8 and above starts
costing crust), and `node test/calibrate.js grillhot` prints what wide open does to it minute by
minute. Cheese goes on for the last minute, with the lid down, or it ends up on the coals. As the bed
burns down it cools at the same vent setting — ash chokes it and a shallower bed runs cooler — so **Stir** it, or
open the vent a notch, or put more coals on well before you need them.

Put a chunk of hickory on three minutes before the meat and the same cook still scores 100, and the
smoke is worth three of the twenty crust marks on any cook that has not already earned them all: a
moderate line of clean smoke is flavour. What is not flavour is a smothered fire. Lid on with both
vents shut and the wood stops burning its volatiles: the bed falls, the smoke goes white, and the
creosote it leaves on the meat costs up to six. If the lid is on, leave the lid vent open — that is
what draws the smoke across the food and out.

That last one is what the **two-zone fire** is for. Bank the coals fully, give the bars five to ten
minutes to settle (they are half there in two, and you can sear over the pile while they find the
rest of it), and sear over the pile — then, once the crust has set (about three minutes, so it lifts
without tearing), drag it across to the bare side and let it coast. A 20 mm patty over vents on 9
that stays over the coals lands medium-rare with a face and a half of char and scores in the
seventies; the same patty seared for three minutes and then moved finishes with a quarter of the
char and scores in the high eighties. It takes a minute or so longer, and pull it about 2 °C higher
than you would on the hot side: a patty that finished gently carries less heat in its crust, so
there is less carry-over coming.

On a **pan**, position moves the metal but not the clock. The rim of a 12" pan on gas really is
40–60 °C cooler than the middle when you lay the meat down, and the patty reads it. But the middle
of a pan over a ring burner is a small reservoir with no flame directly under it while the rim is a
big one sitting right over the flame, and while the underside is still boiling the surface is
pinned at 100 °C either way — so on a pan, moving a patty buys you a different sear, room for
another burger, and a way off the hot spot, not a different cooking time. On coals it buys you the
cooking time as well.

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
test/run.js              npm test: shards the suite across worker processes
test/calibrate.js        scenario runner used to tune the constants (pan and kettle)
test/perf.js             benchmark: milliseconds of CPU per simulated second
test/player.js           recipe sweep: `node test/player.js [grill] [quick] [order]`
test/e2e/                end-to-end scenarios played in a real browser (npm run e2e)
.github/workflows/test.yml   the smoke import and the suite, on Node 22 and 24
```
