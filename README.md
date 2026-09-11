# Griddle

A bad burger-cooking simulator where heat, timing and decisions matter.

Play it here [f1zz1c0ke.github.io/griddle](https://f1zz1ec0ke.github.io/griddle/)

Work a six-ticket shift, if you have the patience because this shit is real time, get the doneness and toppings right, and send everything out hot. Or jump into **Free practice** and experiment without orders or scores. **Hard mode** takes away the thermometers.

Desktop browser, mouse and keyboard. No mobile support.

## Play locally

With Node.js 22+ and Python 3 installed:

```sh
npm start
```

Open [localhost:8000](http://localhost:8000). GG

## Controls

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

No, do whatever you want with this, I don't care. 
