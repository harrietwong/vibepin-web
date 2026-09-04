class InvalidSingleRowShape(ValueError):
    pass


def exact_single_mapping(data: object) -> dict:
    """Accept maybe_single()'s dict/None contract and reject ambiguous shapes."""
    if data is None:
        return {}
    if isinstance(data, dict):
        return data
    raise InvalidSingleRowShape("expected one mapping or no row")
