# Real kitchen

Separate first-person practice mode. Legacy service, practice and saves retain their existing behaviour.

`real-model.js` owns five independent station states, inventory, portioning, transfers, assembly and the versioned `griddle.real.v1` save. `real-mode.js` owns the scene, movement, ray targets, hands and controlled interaction animations. Embedded legacy viewports share one renderer and food textures; they do not create orbit controls or draw independently.

Room fixtures come from `kitchen-room.js` asset references. Both modes use the same food, cold-topping, pan, spatula, probe and material builders. Real captures reflections from its own room once. `chef-rig.js` supplies articulated hands; tools without a Legacy equivalent retain their Real models. Counter placement and shaping check occupied footprints. Placement previews include the complete burger; tool rests require deliberate placement. Saved tool rests migrate with the layout.

Food grids travel with food. Pan transfers move the pan's heat, oil, residue and attached food together. Off-stove pans continue cooling and cooking their contents. A separate loose-food state handles resting ingredients. Stove profiles are restored from installed code rather than save data.

Controls: WASD, Shift jog, Space jump, C crouch. Left-hold reaches/turns/pours/seasons, right-click picks up and places. With a spatula, tongs or spoon, right-click lifts compatible food. The glove carries hot pans and trays. At the bowl, left-hold takes mince and right-click returns 25 g. Hold left click on the board to shape a portion. Scroll adjusts thickness, probe insertion or placement rotation. E lifts a burger layer; the cloth removes topmost sauce. A loaded plate gives tasting feedback.

Endless fridge ingredients require preparation: crack eggs, slice whole buns, tomatoes, pickles, cheese and onions. Salt added to mince uses the existing mixed-salt model; surface seasoning updates the existing water-holding term. Actual salt quantities are retained in the portion ledger; Real interpolates the existing water-holding endpoints by dose; this is a gameplay response, not a calibrated chemistry model.

Place a patty onto a bottom bun to begin assembly, then add prepared toppings and the matching crown. Use the knife to inspect the centre. Tools return to their rests; arbitrary placement near an unsupported counter edge slides and falls. This is controlled placement, not a general rigid-body solver.

The oven finishes up to four patties in fixed rack positions, or takes one tray. Tray placement checks the food footprint; toppings cook on hobs. Tray temperature is a simple handling cue, separate from the food heat solver. Real mode has no orders, scoring UI or multiplayer yet.

Covered pans travel with their lids. Put carried food down before reusing its utensil. Egg cracking and bun splitting check for space first; eggs lost through the grill leave cooking debris, not inventory items.

Look at a pan to read its centre temperature in your selected units. Perimeter fixtures sit against the walls; the oven faces into the room. Older saves migrate fixture positions and food left on their counters.

The gold ring marks the targeted food. Utensils have forgiving reach; placement ghosts appear only at valid locations. A patty and bottom bun can start a burger in either placement order, including building on a plated bottom bun.

Validation: model tests cover independent heat, exact food/pan transfer, portion and salt conservation, preparation, assembly, tray ownership and save continuation. Browser checks exercise actual pointer input from fridge to heated pan, plus tool actions, hot handling, cutaways and restoration. The audit also covers discarded-target cleanup, hot surfaces, failed transfers, loaded saves and slow-frame timing. Cooking uses fixed 50 ms steps with up to 250 ms of catch-up per rendered frame. Software WebGL checks do not establish hardware frame rates.
