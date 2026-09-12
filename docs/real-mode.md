# Real kitchen

Separate first-person practice mode. Legacy service, practice and saves retain their existing behaviour.

`real-model.js` owns five independent station states, inventory, portioning, transfers, assembly and the versioned `griddle.real.v1` save. `real-mode.js` owns the scene, movement, ray targets, hands and controlled interaction animations. Embedded legacy viewports share one renderer and food textures; they do not create orbit controls or draw independently.

Food grids travel with food. Pan transfers move the pan's heat, oil, residue and attached food together. Off-stove pans continue cooling and cooking their contents. A separate loose-food state handles resting ingredients. Stove profiles are restored from installed code rather than save data.

Controls: WASD, Shift jog, Space jump, Ctrl crouch. Left-hold reaches/turns/pours/seasons, right-click picks up and places. With a spatula, tongs or spoon, right-click lifts compatible food. The glove carries hot pans and trays. At the bowl, left-hold takes mince and right-click returns 25 g. Left-click the board with a portion to shape it.

Endless fridge ingredients require preparation: crack eggs, slice whole buns, tomatoes, pickles, cheese and onions. Salt added to mince uses the existing mixed-salt model; surface seasoning updates the existing water-holding term. Actual salt quantities are retained in the portion ledger; the underlying solver still distinguishes salt categories rather than modelling dose-dependent chemistry.

Place a patty onto a bottom bun to begin assembly, then add prepared toppings and the matching crown. Use the knife to inspect the centre. Tools return to their rests; arbitrary placement near an unsupported counter edge slides and falls. This is controlled placement, not a general rigid-body solver.

The oven currently finishes patties, loose or on a tray; toppings cook on hobs. Tray temperature is a simple handling cue, separate from the food heat solver. Real mode has no orders, scoring UI or multiplayer yet.

Validation: model tests cover independent heat, exact food/pan transfer, portion and salt conservation, preparation, assembly, tray ownership and save continuation. Browser checks exercise actual pointer input from fridge to heated pan, plus tool actions, hot handling, cutaways and restoration. Software WebGL checks do not establish hardware frame rates.
