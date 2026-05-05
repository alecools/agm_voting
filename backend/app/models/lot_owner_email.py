# lot_owner_emails table has been dropped in the persons refactor migration.
# This shim exists only to prevent ImportError on any code that still references
# the old module. New code must use Person and lot_persons instead.
# The LotOwnerEmail class is intentionally NOT exported — callers that tried to
# use it will get an AttributeError, which surfaces the issue clearly.
