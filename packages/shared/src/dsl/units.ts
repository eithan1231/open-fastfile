// Unit normalization. The resolver works exclusively in meters and radians;
// everything an author writes in cm/ft/in/deg gets converted once, here.

export function toMeters(value: number, unit: string | undefined): number {
  switch (unit) {
    case undefined:
    case "m":
      return value;
    case "cm":
      return value / 100;
    case "mm":
      return value / 1000;
    case "ft":
      return value * 0.3048;
    case "in":
      return value * 0.0254;
    default:
      // Schema validation should have already rejected this; fall back to
      // treating it as meters so downstream code never sees NaN.
      return value;
  }
}

export function toRadians(value: number, unit: string | undefined): number {
  switch (unit) {
    case undefined:
    case "deg":
      return (value * Math.PI) / 180;
    case "rad":
      return value;
    default:
      return (value * Math.PI) / 180;
  }
}
