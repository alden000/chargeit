/**
 * The compact, normalised shape the ChargeIt Worker serves to the app.
 *
 * LTA's EVCBatch file is verbose, inconsistently cased and has a few quirks
 * (e.g. `longtitude`), so the Worker flattens it into this shape once and
 * every client reads the same clean structure.
 */

/** 1 = free, 0 = in use, null = out of service / unknown. */
export type ConnectorStatus = 0 | 1 | null;

export interface Connector {
  id: string;
  s: ConnectorStatus;
}

export interface Plug {
  /** e.g. "Type 2", "Combo 2 (CCS2)", "CHAdeMO" */
  type: string;
  current: "AC" | "DC" | "";
  /** Power rating in kW, or null if not published. */
  kw: number | null;
  /** Price in SGD per `priceType` unit, or null if not published. */
  price: number | null;
  /** Usually "kWh"; "free" means no charge; "" means unknown. */
  priceType: string;
  connectors: Connector[];
}

export interface ChargePoint {
  operator: string;
  /** Lot / level, e.g. "L4 51 & 52". */
  position: string;
  hours: string;
  plugs: Plug[];
}

export interface Station {
  id: string;
  name: string;
  address: string;
  postal: string;
  lat: number;
  lng: number;
  points: ChargePoint[];
}

export interface ChargersPayload {
  v: 1;
  /** ISO timestamp of LTA's own LastUpdatedTime, if the feed had one. */
  feedUpdated: string | null;
  /** ISO timestamp of when the Worker pulled the file from LTA. */
  fetchedAt: string;
  stations: Station[];
}
