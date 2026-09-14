# Real kitchen

Separate first-person practice mode. Legacy service, practice and saves retain their existing behaviour.

`real-model.js` owns five independent stations, inventory, preparation, assembly and the `griddle.real.v1` save. `real-build.js` owns ordered assembly and `real-stack-view.js` settles its existing meshes. `real-mode.js` owns movement, the scene and hands; `real-interaction.js` shares placement checks between previews and actions. Embedded Legacy viewports share one renderer and food textures.

Both modes use the same food, cookware, spatula, probe and materials. `real-props.js` supplies tools and whole ingredients without a Legacy model. `real-room-detail.js` finishes the shared fixtures; `chef-rig.js` supplies articulated hands. Real captures reflections from its own room once. Tool rests migrate with the layout while preserving deliberately moved items.

Food grids travel with food. Pan transfers move the pan's heat, oil, residue and attached food together. Off-stove pans continue cooling and cooking their contents. A separate loose-food state handles resting ingredients. Stove profiles are restored from installed code rather than save data.

Controls: WASD, Shift jog, Space jump, C crouch. Left-hold reaches/turns/pours/seasons, right-click picks up and places. With a spatula, tongs or spoon, right-click lifts compatible food. The glove carries hot pans and trays. At the bowl, left-hold takes mince and right-click returns 25 g. Hold left click on the board to shape a portion. Scroll adjusts thickness, probe insertion or placement rotation. E lifts a burger layer; the cloth removes topmost sauce. A loaded plate gives tasting feedback. Hold to insert the probe, release to leave it in a patty, right-click it to remove. Its live reading follows the food through transfers and saves; remove it before flipping, pressing or covering.

Endless fridge ingredients require preparation: crack eggs, slice whole buns, tomatoes, pickles, cheese and onions. Salt added to mince uses the existing mixed-salt model; surface seasoning updates the existing water-holding term. Actual salt quantities are retained in the portion ledger; Real interpolates the existing water-holding endpoints by dose; this is a gameplay response, not a calibrated chemistry model.

Dress the bottom bun in any order, then finish with a top bun. Meat is optional. Rebuild directly on a plate. Cheese keeps its mass and temperature when moved; surface seasoning reaches exposed meat. Eggs flatten under the stack and individual pickle slices fan across the bun. Use the knife to inspect the centre. Tools return to their rests; precarious placement can slide and fall. This is controlled placement, not a general rigid-body solver.

The oven has separate power and temperature dials. Its rack accepts patties and buns, or one tray or metal-handled pan. Prepared toppings cook in trays and pans. Tray temperature is a handling cue, separate from the food heat solver. Real has no orders, scoring UI or multiplayer.

Butter melts before it becomes pan fat; the spoon bastes with that fat. A rake banks coals, a brush cleans the grate, and the cold ash catcher empties into the bin. Tilt a held pan to drain into the sink, another pan or onto a counter; the cloth clears spills. H restores tasting notes. The physical timer retains its remaining time in saves.

Covered pans travel with their lids. Put carried food down before reusing its utensil. Egg cracking and bun splitting check for space first; eggs lost through the grill leave cooking debris, not inventory items.

`real-presentation.js` owns the HUD and menus. Look at a pan or its food for the pan's centre temperature. Brief cues flag browning and burning. Water pools, ripples and bubbles from the same mass and temperature used by the solver; oil floats above the pool. Pause offers sensitivity, field of view, sound, hand movement and temperature units.

The gold ring marks the targeted food. Utensils have forgiving reach; ghosts show valid placements only. Pouring and salt particles follow actual activity, and walking away cancels an unfinished action.

Real autosaves while playing and on pause. Re-entering resumes the current kitchen. Fresh kitchen keeps the prior save under `griddle.real.previous`, recoverable from mode selection. Paused scenes redraw only when needed.

Validation combines model tests, pointer/keyboard cooking, focused browser fixtures and screenshots. It covers every grip, independent heat, preparation, transfers, assembly, placement, save recovery and bounded rendering resources. Cooking uses 50 ms steps with up to 250 ms of catch-up per frame. Software WebGL checks do not establish hardware frame rates.
