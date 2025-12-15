import { createRivetKit } from "@rivetkit/react";
import { useState } from "react";
import type { registry } from "../../server/registry";

const { useActor } = createRivetKit<typeof registry>("http://127.0.0.1:6420");

function App() {
	const [count, setCount] = useState(0);
	const [counterName, setCounterName] = useState("test-counter");

	const counter = useActor({
		name: "counter",
		key: [counterName],
	});

	counter.useEvent("newCount", (x: number) => setCount(x));

	const increment = async () => {
		await counter.connection?.increment(1);
	};

	return (
		<div style={{ padding: "2rem" }}>
			<h1>Rivet Counter</h1>
			<h2>Count: {count}</h2>

			<div style={{ marginBottom: "1rem" }}>
				<label>
					Counter Name:
					<input
						type="text"
						value={counterName}
						onChange={(e) => setCounterName(e.target.value)}
						style={{ marginLeft: "0.5rem", padding: "0.25rem" }}
					/>
				</label>
			</div>

			<button onClick={increment}>Increment</button>

			<div style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#666" }}>
				<p>Connection Status: {counter.isConnected ? "Connected" : "Disconnected"}</p>
				<p>Try opening multiple tabs to see real-time sync.</p>
			</div>
		</div>
	);
}

export default App;
