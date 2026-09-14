# Render profiling

`npm run perf:render` runs a repeatable Real kitchen camera sweep with an empty kitchen and four patties with oil. It uses the same local HTTP/Playwright setup as the browser scenarios. Simulation is held still to isolate rendering.

`npm run perf:render -- --gpu --compare=HEAD` compares the working tree against a local Git revision using Chrome's normal graphics path. Omit `--gpu` for software WebGL. Set `CHROME_PATH` and `PLAYWRIGHT_PATH` if those tools are not already discoverable. Reports include the actual graphics adapter and land in `test/e2e/out/`.

Read frame delivery and CPU submission separately: a fast `renderer.render()` call can still queue slow GPU work. Shader counts and draw calls help explain changes; timings depend on the machine and cache state.

`npm run e2e -- real-render` checks cached shadows against complete shadow renders, including moving objects and lights, shader coverage, and idle particle uploads. Add `--gpu` to check the hardware path.

Startup runs through `js/boot.js`. The HTML loading screen appears before WebGL setup; construction jobs and shader batches yield between updates. Progress counts completed work across kitchen setup and each mode's shaders, not elapsed time or a driver's internal compilation percentage. Mode selection waits for both kitchens. Preparation uses disposable sample geometry, keeps shader materials cached, and never starts or saves a cooking session. `npm run e2e -- loading` checks this flow.

The shadow cache targets the vendored Three.js r128 WebGL2 framebuffer layout. Preserve colour **and** depth when copying it; copying colour alone lets moving shadows overwrite nearer room geometry. Invalidate it if fixed shadow casters become editable. WebGL1, other shadow types and context recovery keep Three's complete shadow rendering.
