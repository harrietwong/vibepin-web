/** Safe server-side error types for Pinterest routes (no credentials in messages). */

export class ConfigurationError extends Error {
  code = "configuration_error";
  constructor(message = "Pinterest is not configured on the server") {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class DatabaseError extends Error {
  code = "database_error";
  constructor(message = "Pinterest connection storage is unavailable") {
    super(message);
    this.name = "DatabaseError";
  }
}

export function isMissingTableError(code: string | undefined, message: string): boolean {
  return (
    code === "PGRST205"
    || code === "42P01"
    || message.includes("Could not find the table")
    // Pre-v59 storage table (kept in the list so a not-yet-migrated deployment that
    // still errors on the old name is still recognised as "storage missing").
    || message.includes("pinterest_connections")
    || message.includes("social_connections")
  );
}
