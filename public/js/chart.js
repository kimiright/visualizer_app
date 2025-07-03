document.addEventListener('DOMContentLoaded', () => {
    const statusIndicator = document.getElementById('status-indicator');
    const canvas = document.getElementById('live-chart');
    const ctx = canvas.getContext('2d');

    // Basic chart placeholder
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'center';
    ctx.font = '20px Arial';
    ctx.fillText('Waiting for data...', canvas.width / 2, canvas.height / 2);


    const socket = new WebSocket(`wss://${window.location.host}/ws`);

    socket.onopen = () => {
        statusIndicator.textContent = 'Status: Connected';
        statusIndicator.style.color = '#28a745';
        console.log('WebSocket connection established.');

        // Send a dummy subscription message
        const subscriptionMessage = {
            action: 'subscribe',
            channel: 'live-updates'
        };
        socket.send(JSON.stringify(subscriptionMessage));
        console.log('Sent subscription request:', subscriptionMessage);
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received data from server:', data);

        // Clear the canvas before drawing new data
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barWidth = canvas.width / data.length;
        let x = 0;

        data.forEach(value => {
            // Assuming the data values are between 0 and 100
            const barHeight = (value / 100) * canvas.height;
            const y = canvas.height - barHeight;

            // Draw the bar
            ctx.fillStyle = '#007bff'; // A nice blue color for the bars
            ctx.fillRect(x, y, barWidth - 2, barHeight); // Subtract 2 for spacing between bars

            x += barWidth;
        });
    };

    socket.onclose = (event) => {
        statusIndicator.textContent = `Status: Disconnected (${event.code})`;
        statusIndicator.style.color = '#dc3545';
        console.log('WebSocket connection closed:', event);
    };

    socket.onerror = (error) => {
        statusIndicator.textContent = 'Status: Connection Error';
        statusIndicator.style.color = '#dc3545';
        console.error('WebSocket error:', error);
    };
});