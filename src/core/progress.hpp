// Progress reports and artifact references. Both are posted to the timeline
// through Messages::submit, so they share its membership rules, sequence and
// idempotency. File contents stay in the project's own storage; the service
// records a verified reference and digest.
#pragma once

#include "common.hpp"
#include "conversation.hpp"
#include "database.hpp"
#include "identity.hpp"
#include "message.hpp"

namespace acm {

class Progress {
public:
    Progress(Database& database, Conversations& conversations, Messages& messages, Clock clock)
        : database_(database), conversations_(conversations), messages_(messages), clock_(std::move(clock)) {}

    // Agent: {conversation_id, stage, run_state, summary, percent?, count_done?,
    //         count_total?, artifact_ids?, recipient_session_ids?, idempotency_key}.
    // run_state is running|waiting|completed|failed|cancelled. percent is 0-100
    // or omitted when it cannot be measured. The source is always recorded as
    // agent_reported: a model cannot claim an observed or measured result.
    json report_progress(const Session& session, const json& args);

    // Agent: {conversation_id, name, relative_path, direction, format?, sha256?,
    //         row_count?, unit?, timezone?, summary?, recipient_session_ids?, idempotency_key}.
    // The path must resolve to an existing regular file inside the project root
    // after links are followed. The service computes the SHA-256 itself and
    // rejects a supplied digest that does not match the file.
    json publish_artifact(const Session& session, const json& args);

    // Agent: {artifact_id}. Requires read access to the artifact's conversation
    // and the same visibility as the message that announced it. Re-checks the
    // file so the reader learns whether it still matches the recorded digest.
    json get_artifact(const Session& session, const json& args);

    // Operator: every artifact reference in a conversation, oldest first.
    json list_artifacts(std::string_view conversation_id);

private:
    json artifact_row(std::string_view artifact_id);

    Database& database_;
    Conversations& conversations_;
    Messages& messages_;
    Clock clock_;
};

}  // namespace acm
