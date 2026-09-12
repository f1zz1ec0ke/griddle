# Visual assessment

September 2026. Aim: a warm, tactile kitchen with readable cooking states.

| Asset | Assessment and work |
| --- | --- |
| Four pans | Rebuilt the shared crude body and block handle. Shaped walls, rounded rims, forged handles, hanging slots, rivets, a cast-iron helper handle, and distinct finishes. |
| Stove and kettle | Beveled hob and gas supports, brushed metal, enamel kettle, textured charcoal and wood. Kept the working grate, vents, and flame behaviour. |
| Oven | Front-facing knobs with bezels, pointers, and dial marks. The old cylinders pointed into the counter. |
| Kitchen furniture | Softened edges on cabinets, island, door panels, trim, and shelving. Added wood grain, stone detail, painted joinery, and metal finishes. |
| Board and utensils | Rounded wooden board, finer metal and wood on the spatula and probe, rounded probe casing and pass trays. |
| Lighting | Rebalanced daylight and fill, added window-direction shadows, improved baked room reflections. Included the absent ceiling in reflections without blocking the overhead camera. |
| Patties | Corrected colour-texture encoding, replaced dotted fat with irregular strands, added mince relief and a less uniform outline. Doneness still comes from simulation state. |
| Buns | Smoother crown, baked surface texture, visible sesame seeds with a natural beige colour. Crumb, toast, and soaking remain state-driven. |
| Cheese | Solid slices, rounded melting corners, corrected colour, and cutaway clipping for fried cheese. |
| Eggs | Closed a broken white-mesh seam and made the yolk a dome rather than a sphere extending underneath the white. |
| Bacon and onions | Fine bacon surface relief; smoother onion arcs with actual thickness. Retained cooking-driven colour, shrinkage, and curl. |
| Cold toppings | Added seeded pickle interiors. Retained tomato seed pockets, folded lettuce, and spreading sauces. |
| Oil | Reduced the opaque colour wash so thin oil reveals the pan beneath its sheen. Retained simulated pooling, movement, and spills. |
| Plants and garden | Replaced chunky potted foliage with pointed, folded leaves and pot rims; added timber texture outside. Kept the layered garden and opening windows. |
| HUD and effects | Kept the SVG controls, cooking cues, steam, smoke, and spatter. Their current shapes serve the game; the material and lighting changes carry the visual upgrade. |

Validation covers geometry bounds and mesh seams, cheese cutaway, browser rendering, assembled burgers, and repeated equipment swaps. Browser checks use desktop Chrome with software WebGL; they do not establish performance on every GPU. No simulation coefficients were changed.
