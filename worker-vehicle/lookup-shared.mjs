// Pure merge/translation logic for the vehicle lookup relay
// (worker-vehicle/worker.js). No I/O here so it can be unit-tested in Node.

export function normaliseReg(raw) {
  const reg = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{2,7}$/.test(reg) ? reg : null;
}

// Current-format plates read better with the standard gap: "AB12 CDE".
export function displayReg(reg) {
  const m = reg.match(/^([A-Z]{2}\d{2})([A-Z]{3})$/);
  return m ? `${m[1]} ${m[2]}` : reg;
}

const title = (s) =>
  s ? String(s).trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null;

const FUEL = {
  PETROL: "Petrol", DIESEL: "Diesel", ELECTRICITY: "Electric", ELECTRIC: "Electric",
  "HYBRID ELECTRIC": "Hybrid", "ELECTRIC DIESEL": "Diesel hybrid",
  "GAS BI-FUEL": "Bi-fuel", "PETROL/GAS": "Bi-fuel", GAS: "Gas",
  "FUEL CELLS": "Hydrogen",
};
export function fuelLabel(v) {
  const k = String(v || "").trim().toUpperCase();
  if (!k) return null;
  return FUEL[k] || title(k);
}

const fmtTonnes = (kg) => {
  const t = kg / 1000;
  return `${t % 1 ? t.toFixed(1) : t}t`;
};

// DVLA type approval + wheelplan + revenue weight -> plain-English class.
// Type approval: M1 car, M2/M3 buses, N1 van <=3.5t, N2 3.5-12t, N3 >12t,
// L* two/three-wheelers, T* tractors. Older vehicles often have it blank, so
// fall back to a weight/wheelplan guess and say that's what it is.
export function classLabel(typeApproval, wheelplan, revenueWeight) {
  const ta = String(typeApproval || "").trim().toUpperCase();
  const wp = String(wheelplan || "").trim().toUpperCase();
  const w = Number(revenueWeight) || null;
  const axles = (wp.match(/^(\d)\s*AXLE/) || [])[1];
  const body = wp.includes("ARTIC") ? "artic" : wp.includes("RIGID") ? "rigid" : "";
  const heavy = [axles ? `${axles}-axle` : "", body].filter(Boolean).join(" ");

  if (ta === "M1") return { label: "Car" };
  if (ta === "M2") return { label: "Minibus" };
  if (ta === "M3") return { label: "Bus / coach" };
  if (ta === "N1") return { label: w ? `Van (${fmtTonnes(w)})` : "Van (≤3.5t)" };
  if (ta === "N2") {
    return {
      label: w === 7500 ? "7.5-tonner" : w ? `${fmtTonnes(w)} truck` : "Truck (3.5–12t)",
      detail: heavy || null,
    };
  }
  if (ta === "N3") {
    return { label: w ? `HGV (${fmtTonnes(w)})` : "HGV (>12t)", detail: heavy || null };
  }
  if (ta.startsWith("L")) {
    return { label: ["L5", "L6", "L7"].includes(ta) ? "Trike / quad" : "Motorbike / moped" };
  }
  if (ta.startsWith("T")) return { label: "Tractor" };

  // No class on record — best guess, flagged as such.
  if (wp.includes("MOTORCYCLE") || wp === "2 WHEELS") {
    return { label: "Motorbike / moped", detail: "class not recorded" };
  }
  if (w && w > 12000) return { label: `HGV (${fmtTonnes(w)})`, detail: "class not recorded" };
  if (w && w > 3500) return { label: `${fmtTonnes(w)} truck`, detail: "class not recorded" };
  return { label: "Car / light vehicle", detail: "class not recorded" };
}

export function taxBadge(taxStatus, taxDueDate) {
  const s = String(taxStatus || "").trim().toUpperCase();
  if (!s) return { status: "UNKNOWN", ok: null };
  if (s === "TAXED") return { status: "TAXED", ok: true, due: taxDueDate || null };
  if (s === "SORN") return { status: "SORN", ok: false };
  // "Untaxed", "Not Taxed for on Road Use" and any future variants.
  return { status: "UNTAXED", ok: false, due: taxDueDate || null };
}

// First MOT is due three years after first use; before that "not valid" from
// DVLA really means "not needed yet". Dates arrive as ISO or dotted (2017.05.25).
function firstMotDue(dvla, dvsa) {
  const raw =
    (dvsa && (dvsa.firstUsedDate || dvsa.registrationDate)) ||
    (dvla && dvla.monthOfFirstRegistration) || null;
  if (!raw) return null;
  const d = new Date(String(raw).replace(/\./g, "-"));
  if (Number.isNaN(+d)) return null;
  d.setFullYear(d.getFullYear() + 3);
  return d;
}

export function motBadge(dvla, dvsa, now = new Date()) {
  const s = String((dvla && dvla.motStatus) || "").trim().toUpperCase();
  if (s === "VALID") {
    return { status: "VALID", ok: true, expires: (dvla && dvla.motExpiryDate) || null };
  }
  const due = firstMotDue(dvla, dvsa);
  if (due && due > now) return { status: "NOT DUE YET", ok: true, due: due.toISOString().slice(0, 10) };
  if (s === "NOT VALID") {
    return { status: "NOT VALID", ok: false, expires: (dvla && dvla.motExpiryDate) || null };
  }
  // DVLA holds nothing (or the DVLA call failed) — latest DVSA test decides.
  let exp = null;
  for (const t of (dvsa && dvsa.motTests) || []) {
    if (t.expiryDate && (!exp || t.expiryDate > exp)) exp = t.expiryDate;
  }
  if (exp) {
    return new Date(exp) >= now
      ? { status: "VALID", ok: true, expires: exp }
      : { status: "NOT VALID", ok: false, expires: exp };
  }
  return { status: "UNKNOWN", ok: null };
}

// dvla/dvsa: { ok, status, data?, error? } from the two upstream calls.
export function buildPayload(reg, dvla, dvsa, now = new Date()) {
  const d = dvla.ok ? dvla.data : null;
  const m = dvsa.ok ? dvsa.data : null;
  const notes = [];
  if (!dvla.ok) {
    notes.push(dvla.status === -1
      ? "Tax status & weight class arrive when DVLA API access reopens."
      : dvla.status === 404
        ? "No DVLA record for this registration."
        : "DVLA lookup unavailable — tax/class missing.");
  }
  if (!dvsa.ok) {
    notes.push(dvsa.status === 404
      ? "No MOT record — model unavailable."
      : "MOT service unavailable — model missing.");
  }
  const year =
    (d && d.yearOfManufacture) ||
    (m && m.manufactureDate && +String(m.manufactureDate).slice(0, 4)) || null;
  const recallRaw = m && m.hasOutstandingRecall;
  return {
    reg: displayReg(reg),
    found: !!(d || m),
    make: title((d && d.make) || (m && m.make)),
    model: title(m && m.model),
    colour: title((d && d.colour) || (m && m.primaryColour)),
    fuel: fuelLabel((d && d.fuelType) || (m && m.fuelType)),
    year,
    age: year ? Math.max(0, now.getFullYear() - year) : null,
    vclass: d ? classLabel(d.typeApproval, d.wheelplan, d.revenueWeight) : null,
    tax: d ? taxBadge(d.taxStatus, d.taxDueDate) : { status: "UNKNOWN", ok: null },
    mot: motBadge(d, m, now),
    // Not shown in the app (out of spec) but cheap to carry.
    recall: typeof recallRaw === "string" ? /^yes$/i.test(recallRaw) : recallRaw === true || null,
    notes,
  };
}
