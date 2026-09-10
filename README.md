# Griddle

A burger-cooking simulator where heat, timing and bad decisions matter.

Work a six-ticket shift, get the doneness and toppings right, and send everything out hot. Or jump into **Free practice** and experiment without orders or scores. **Hard mode** takes away the thermometers.

Desktop browser, mouse and keyboard. No mobile support.

## Play locally

With Node.js 22+ and Python 3 installed:

```sh
npm start
```

Open [localhost:8000](http://localhost:8000). No dependencies to install or build step. Any static web server works too.

## Controls

| Input | Action |
|---|---|
| Left-drag / mouse wheel | Rotate / zoom |
| Drag food | Move it around the pan |
| Space / F | Place or flip / flip |
| `[` / `]` | Select food |
| C | Toggle cutaway |
| 1–4 / R | Camera presets / reset |

Use the panel for cooking, **Kitchen** for saves and settings, and **Help** for the full controls. You can pause, reheat food, and replace ruined toppings.

Service and practice save separately in your browser. Resume picks up paused; nothing cooks while you're away.

## Development

Plain HTML, CSS and JavaScript with vendored Three.js.

```sh
npm test          # physics and gameplay tests
npm run perf      # simulation performance
```
