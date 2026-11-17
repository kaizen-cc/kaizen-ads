import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { cleanList, consentValue, normalizeEmail, normalizePhone, removedRows, splitName, titleCase, validEmail, emailFlag, type CleanResult } from "@/lib/list-clean/core";
import { parseCsv, toCsv, decodeText } from "@/lib/list-clean/csv";
import { excelDate, readXlsx } from "@/lib/list-clean/xlsx";

const ok = (r: CleanResult) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("csv", () => {
  it("reads quotes, commas, line breaks and a byte order mark", () => {
    const rows = parseCsv('﻿Name,Note\r\n"Smith, Jo","said ""hi""\nthere"\r\n\r\nPat,ok\r\n');
    expect(rows).toEqual([["Name", "Note"], ["Smith, Jo", 'said "hi"\nthere'], [], ["Pat", "ok"]]);
  });
  it("finds semicolon and tab files", () => {
    expect(parseCsv("a;b;c\n1;2;3")[1]).toEqual(["1", "2", "3"]);
    expect(parseCsv("a\tb\n1\t2")[1]).toEqual(["1", "2"]);
  });
  it("writes cells that need quotes", () => {
    expect(toCsv([["a", 'b,"c"', "x\ny"]])).toBe('a,"b,""c""","x\ny"\r\n');
  });
  it("reads Windows-1252 and UTF-16 text", () => {
    expect(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]))).toBe("José");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe("a");
  });
});

describe("emails", () => {
  it("normalises and repairs", () => {
    expect(normalizeEmail("  Jo.Smith@GMAIL.com ").email).toBe("jo.smith@gmail.com");
    expect(normalizeEmail("Jo <JO@x.com>").email).toBe("jo@x.com");
    expect(normalizeEmail("mailto:jo@x.com;").email).toBe("jo@x.com");
    expect(normalizeEmail("a@x.com; b@y.com").email).toBe("a@x.com");
    expect(normalizeEmail("jo@gmial.com")).toEqual({ email: "jo@gmail.com", fixed: true });
    expect(normalizeEmail("jo@shop.con").email).toBe("jo@shop.com");
    expect(normalizeEmail("JO@x.com").fixed).toBe(false);
  });
  it("validates", () => {
    for (const e of ["a@b.co", "a.b+c@sub.example.com", "o'brien@x.io"]) expect(validEmail(e)).toBe(true);
    for (const e of ["a@b", "a@@b.com", ".a@b.com", "a..b@c.com", "a b@c.com", "a@b.c", "@b.com", "a@-b.com"]) expect(validEmail(e)).toBe(false);
  });
  it("flags disposable, role and placeholder addresses", () => {
    expect(emailFlag("x@mailinator.com")).toBe("disposable");
    expect(emailFlag("info@shop.com")).toBe("role");
    expect(emailFlag("support+tag@shop.com")).toBe("role");
    expect(emailFlag("a@example.com")).toBe("placeholder");
    expect(emailFlag("test@shop.com")).toBe("placeholder");
    expect(emailFlag("jo@shop.com")).toBeNull();
  });
});

describe("phones", () => {
  it("formats US numbers", () => {
    expect(normalizePhone("(555) 234-5678")).toBe("+15552345678");
    expect(normalizePhone("1-555-234-5678")).toBe("+15552345678");
    expect(normalizePhone("555.234.5678 x12")).toBe("+15552345678");
    expect(normalizePhone("+1 (555) 234-5678")).toBe("+15552345678");
  });
  it("rejects what can't be a number", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("0000000000")).toBeNull();
    expect(normalizePhone("(055) 234-5678")).toBeNull();
    expect(normalizePhone("n/a")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
  it("uses the default country", () => {
    expect(normalizePhone("07911 123456", "GB")).toBe("+447911123456");
    expect(normalizePhone("0412 345 678", "AU")).toBe("+61412345678");
    expect(normalizePhone("+44 7911 123456", "US")).toBe("+447911123456");
    expect(normalizePhone("0044 7911 123456", "US")).toBe("+447911123456");
    expect(normalizePhone("447911123456", "US")).toBe("+447911123456");
  });
});

describe("names", () => {
  it("title-cases only shouting or lowercase names", () => {
    expect(titleCase("JOHN")).toBe("John");
    expect(titleCase("mary-jane o'brien")).toBe("Mary-Jane O'Brien");
    expect(titleCase("McDonald")).toBe("McDonald");
    expect(titleCase("mcdonald")).toBe("McDonald");
    expect(titleCase("DeShawn")).toBe("DeShawn");
  });
  it("splits a full name", () => {
    expect(splitName("jane doe")).toEqual({ first: "Jane", last: "Doe" });
    expect(splitName("Dr. Mary van der Berg Jr")).toEqual({ first: "Mary", last: "van der Berg Jr" });
    expect(splitName("Berg, Mary")).toEqual({ first: "Mary", last: "Berg" });
    expect(splitName("Madonna")).toEqual({ first: "Madonna", last: "" });
    expect(splitName("jo@x.com")).toEqual({ first: "", last: "" });
  });
  it("reads consent words", () => {
    expect(consentValue("Subscribed")).toBe("yes");
    expect(consentValue("yes")).toBe("yes");
    expect(consentValue("Not subscribed")).toBe("no");
    expect(consentValue("never subscribed")).toBe("no");
    expect(consentValue("Unsubscribed")).toBe("suppressed");
    expect(consentValue("cleaned")).toBe("suppressed");
    expect(consentValue("")).toBe("blank");
  });
});

describe("cleanList", () => {
  const source = [
    ["Email Address", "First", "LAST NAME", "Mobile", "ZIP Code", "State", "Accepts Marketing", "Plan", "Notes"],
    ["  Jo@Gmial.com ", "JO", "SMITH", "(555) 234-5678", "2134", "ma", "yes", "gold", "vip"],
    ["jo@gmail.com", "Jo", "Smith", "", "", "", "yes", "gold", ""],
    ["bad-email", "No", "Email", "555", "", "", "no", "", ""],
    ["info@shop.com", "Shop", "Owner", "", "", "", "yes", "", ""],
    ["x@mailinator.com", "T", "T", "", "", "", "yes", "", ""],
    ["gone@x.com", "Gone", "Away", "", "", "", "unsubscribed", "", ""],
    ["", "", "", "", "", "", "", "", ""],
    ["pat@x.com", "pat", "lee", "07911 123456", "", "", "no", "silver", ""],
  ];
  const res = ok(cleanList(source));
  it("renames to Klaviyo properties and keeps custom ones", () => {
    expect(res.header).toEqual(["$email", "$first_name", "$last_name", "$phone_number", "$region", "$zip", "$consent", "Plan", "Notes"]);
  });
  it("cleans the rows that stay", () => {
    expect(res.rows[0]).toEqual(["jo@gmail.com", "Jo", "Smith", "+15552345678", "MA", "02134", "email", "gold", "vip"]);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[1][0]).toBe("pat@x.com");
    expect(res.rows[1][3]).toBe(""); // a UK number with a US default can't be a US number
    expect(res.rows[1][6]).toBe("");
  });
  it("says why each row went", () => {
    const why = Object.fromEntries(res.removed.map((r) => [r.line, r.reason]));
    expect(why[3]).toBe("Duplicate email");
    expect(why[4]).toBe("No valid email address");
    expect(why[5]).toBe("Role address (info@, support@ and the like)");
    expect(why[6]).toBe("Disposable email address");
    expect(why[7]).toBe("Unsubscribed or suppressed in the source list");
    expect(res.stats.rowsIn).toBe(7);
    expect(res.stats.kept).toBe(2);
    expect(res.stats.emailsRepaired).toBe(1);
    expect(res.stats.zipsPadded).toBe(1);
  });
  it("writes the removed file with the original columns", () => {
    const rows = removedRows(res);
    expect(rows[0].slice(0, 3)).toEqual(["Removed because", "Line in your file", "Email Address"]);
    expect(rows).toHaveLength(6);
  });
  it("can keep role and disposable addresses", () => {
    const r = ok(cleanList(source, { keepRole: true, keepDisposable: true }));
    expect(r.rows.map((x) => x[0])).toContain("info@shop.com");
    expect(r.rows.map((x) => x[0])).toContain("x@mailinator.com");
  });
  it("uses the default country for phones", () => {
    const r = ok(cleanList(source, { defaultCountry: "GB" }));
    expect(r.rows[1][3]).toBe("+447911123456");
  });
  it("splits a full name and finds an email column with no header", () => {
    const r = ok(cleanList([["Customer Name", "Contact"], ["jane doe", "jane@x.com"], ["SAM LEE", "sam@x.com"], ["bob", "bob@x.com"]]));
    expect(r.header).toEqual(["$email", "$first_name", "$last_name"]);
    expect(r.rows[0]).toEqual(["jane@x.com", "Jane", "Doe"]);
    expect(r.rows[1].slice(0, 3)).toEqual(["sam@x.com", "Sam", "Lee"]);
    expect(r.stats.namesSplit).toBe(3);
  });
  it("keeps a row with a good phone and a bad email for text", () => {
    const r = ok(cleanList([["email", "phone"], ["nope", "555-234-5678"], ["a@x.com", ""]]));
    expect(r.rows).toEqual([["", "+15552345678"], ["a@x.com", ""]]);
    expect(r.stats.smsOnly).toBe(1);
  });
  it("needs an email column", () => {
    const r = cleanList([["a", "b"], ["1", "2"]]);
    expect(r.ok).toBe(false);
  });
  it("refuses an unknown country", () => {
    expect(cleanList([["email"], ["a@x.com"]], { defaultCountry: "ZZ" }).ok).toBe(false);
  });
  it("keeps duplicate custom headers apart and skips blank lines before the header", () => {
    const r = ok(cleanList([[], ["Email", "Tag", "Tag"], ["a@x.com", "1", "2"]]));
    expect(r.header).toEqual(["$email", "Tag", "Tag (2)"]);
    expect(r.headerLine).toBe(2);
  });
  it("turns email and text consent into one column", () => {
    const r = ok(cleanList([["Email", "Phone", "Email Consent", "SMS Consent", "Consent Date"], ["a@x.com", "555-234-5678", "yes", "yes", "2025-01-02"], ["b@x.com", "555-234-5679", "yes", "no", "2025-01-03"], ["c@x.com", "", "no", "", "2025-01-04"]]));
    expect(r.header).toEqual(["$email", "$phone_number", "$consent", "$consent_timestamp"]);
    expect(r.rows.map((x) => x[2])).toEqual(["email,sms", "email", ""]);
    expect(r.rows[2][3]).toBe("");
  });
  it("cleans 100,000 rows in a couple of seconds", () => {
    const rows: string[][] = [["email", "name", "phone"]];
    for (let i = 0; i < 100_000; i++) rows.push([`User${i % 90_000}@Example${(i % 90_000) % 7}.org`, `first${i} LAST${i}`, `(555) 2${String(i).padStart(2, "0")}-${String(1000 + (i % 9000))}`]);
    const t = Date.now();
    const r = ok(cleanList(rows));
    expect(Date.now() - t).toBeLessThan(4000);
    expect(r.stats.rowsIn).toBe(100_000);
    expect(r.stats.removed["Duplicate email"]).toBeGreaterThan(0);
  });
});

describe("xlsx", () => {
  const cell = (r: string, v: string, t?: string, s?: number) => `<c r="${r}"${t ? ` t="${t}"` : ""}${s != null ? ` s="${s}"` : ""}><v>${v}</v></c>`;
  const book = () =>
    zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns:r="x"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`),
      "xl/sharedStrings.xml": strToU8(`<sst><si><t>Email</t></si><si><t>Joined</t></si><si><t>jo@x.com</t></si><si><r><t>A &amp; </t></r><r><t>B</t></r></si></sst>`),
      "xl/styles.xml": strToU8(`<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet><sheetData><row r="1">${cell("A1", "0", "s")}${cell("B1", "1", "s")}${cell("D1", "3", "s")}</row><row r="3">${cell("A3", "2", "s")}${cell("B3", "45658", undefined, 1)}${cell("C3", "5.551234568E9")}</row></sheetData></worksheet>`,
      ),
      "xl/worksheets/sheet2.xml": strToU8(`<worksheet><sheetData/></worksheet>`),
    });
  it("reads strings, dates, numbers and skips hidden sheets", () => {
    const r = readXlsx(book());
    if (!r.ok) throw new Error(r.error);
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets[0].rows[0]).toEqual(["Email", "Joined", "", "A & B"]);
    expect(r.sheets[0].rows[1]).toEqual([]);
    expect(r.sheets[0].rows[2]).toEqual(["jo@x.com", "2025-01-01", "5551234568"]);
  });
  it("turns Excel dates into days", () => {
    expect(excelDate(45658)).toBe("2025-01-01");
    expect(excelDate(45658.5)).toBe("2025-01-01 12:00:00");
  });
  it("says when it isn't a workbook", () => {
    const r = readXlsx(new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(false);
  });
});
