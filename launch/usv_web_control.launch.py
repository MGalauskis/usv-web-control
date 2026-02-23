"""
ROS2 launch file for USV Web Control.

Usage:
    ros2 launch launch/usv_web_control.launch.py
    ros2 launch launch/usv_web_control.launch.py port:=9090 joy_topic:=/cmd_joy
    ros2 launch launch/usv_web_control.launch.py port:=9090 title:=my_usv
"""

import os
import socket
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    # Resolve project root (one level up from this launch file)
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    port = LaunchConfiguration('port')
    title = LaunchConfiguration('title')
    joy_topic = LaunchConfiguration('joy_topic')

    return LaunchDescription([
        DeclareLaunchArgument('port', default_value='8888',
                              description='HTTP/WebSocket server port'),
        DeclareLaunchArgument('title', default_value=socket.gethostname(),
                              description='Display name sent to browser'),
        DeclareLaunchArgument('joy_topic', default_value='/joy',
                              description='ROS2 topic for joystick output'),

        ExecuteProcess(
            cmd=[
                'python3', '-m', 'server.usv_node',
                '--ros-args',
                '-p', ['port:=', port],
                '-p', ['joy_topic:=', joy_topic],
                '-p', ['title:=', title],
            ],
            cwd=project_root,
            output='screen',
        ),
    ])
