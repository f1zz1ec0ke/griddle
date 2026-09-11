/* Brief sensory milestones. UI-only: no changes to the cooking model. */
(function (root) {
  'use strict';
  class CookingCues {
    constructor() { this.faces = new WeakMap(); this.active = []; this.serial = 0; }
    update(foods, now, quiet = false) {
      // A cue describes the current underside, so remove it on a flip or lift.
      this.active = this.active.filter(c => c.until > now && foods.includes(c.food) && c.food.where === 'pan' && c.food.faceDown === c.face);
      for (const food of foods) {
        if (food.where !== 'pan' || !food.faceDown) continue;
        const face = food.faceDown;
        const level = face.char > .25 ? 3 : face.brown > 2.5 ? 2 : face.brown > 1 ? 1 : 0;
        const seen = this.faces.get(face) || 0;
        if (level <= seen) continue;
        this.faces.set(face, level);
        if (quiet) continue; // Restored paused sessions do not replay old milestones.
        this.active = this.active.filter(c => c.food !== food);
        this.active.push({ id: ++this.serial, food, face, level, until: now + 6000,
          title: ['','Browning underneath','Golden crust','Bottom is burning'][level],
          icon: level === 3 ? 'burn' : 'brown',
          label: food.kind ? (food.label || food.spec.short) + ' · ' + food.id : 'Patty ' + food.id });
      }
      // Burns stay ahead of less urgent updates. All foods remain identified.
      return this.active.slice().sort((a, b) => b.level - a.level || b.id - a.id).slice(0, 3);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = CookingCues;
  else root.CookingCues = CookingCues;
})(typeof window !== 'undefined' ? window : globalThis);
