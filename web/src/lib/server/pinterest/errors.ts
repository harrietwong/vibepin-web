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
    || message.includes("Could not find the table")
    || message.includes("pinterest_connections")
  );
}
