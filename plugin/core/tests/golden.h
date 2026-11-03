// Reader for tests/golden/core.golden.txt (written by tests/golden.test.ts in the web app).
#pragma once

#include <map>
#include <string>
#include <vector>

namespace golden {

struct Record {
    std::string kind, name;
    std::vector<double> v;
};

/** All records, in file order. Loaded once. */
const std::vector<Record>& records();
/** The values of the one record of this kind and name (empty + test failure if missing). */
const std::vector<double>& get(const std::string& kind, const std::string& name);

} // namespace golden
