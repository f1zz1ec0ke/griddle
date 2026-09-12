# Griddle

A bad burger-cooking simulator where heat, timing and decisions matter.

Play it here [f1zz1c0ke.github.io/griddle](https://f1zz1ec0ke.github.io/griddle/)

Work a six-ticket shift, if you have the patience because this shit is real time, get the doneness and toppings right, and send everything out hot. Or jump into **Free practice** and experiment without orders or scores. **Hard mode** takes away the thermometers.

Desktop browser, mouse and keyboard. No mobile support.

Choose **Legacy** for the original game or **Real** for first-person practice: walk the kitchen, prepare ingredients and cook with physical tools. Real saves separately.

## Play locally

With Node.js 22+ and Python 3 installed:

```sh
npm start
```

Open [localhost:8000](http://localhost:8000). GG

## Controls

**Real:** WASD to walk, Shift to jog, Space to jump, C to crouch. Hold left click to interact or use a tool; right click to pick up, lift food with a tool, or place it. Scroll adjusts slice/patty thickness, probe depth or placement rotation. E lifts the top burger layer; the cloth wipes sauce. Put your cook on the plate and left click to taste. Esc pauses. Open the fridge to get started.

**Legacy:**

| Input | Action |
|---|---|
| Left-drag / mouse wheel | Rotate / zoom |
| Drag food | Move it around the pan |
| Space / F | Place or flip / flip |
| `[` / `]` | Select food |
| C | Toggle cutaway |
| 1–4 / R | Camera presets / reset |

Use the dock to cook, then **Build** to stack rested food, fresh toppings and sauces. **Undo layer** or **Unpack** lets you change it. **Replace patty** starts a fresh one during service; the order clock keeps running. **Open window** clears lingering smoke. **Menu** has saves and settings; **Help** has the full controls.

Service and practice save separately in your browser. Resume picks up paused; nothing cooks while you're away.

## Development

Plain HTML, CSS and JavaScript with vendored Three.js.

```sh
npm test          # physics and gameplay tests
npm run perf      # simulation performance
```

## You got a loicense for that burger mate?

You may not sell this or repurpose/reuse it in any way with the intention of selling it. Beyond that I don’t care.
